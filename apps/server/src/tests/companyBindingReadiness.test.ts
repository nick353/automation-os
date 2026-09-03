import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCompanyBindingReadinessV1,
  type CompanyBindingReadinessInput
} from "../runs/companyBindingReadiness.js";

const baseSchedule = {
  id: "schedule-1",
  company_id: "company-1",
  automation_id: "automation-1",
  automation_name: "Daily automation",
  kind: "daily",
  expression: "09:00",
  timezone: "Asia/Tokyo",
  enabled: true,
  status: "active",
  revision: 1,
  next_run_at: "2026-09-04T00:00:00.000Z",
  last_run_at: null,
  catch_up_policy: null
} as const;

function input(overrides: Partial<CompanyBindingReadinessInput> = {}): CompanyBindingReadinessInput {
  return {
    now: "2026-09-03T00:00:00.000Z",
    trigger_company_id: "company-1",
    trigger_provenance: "test_trigger",
    local_companies: [{ company_id: "company-1", automation_count: 1, provenance: "test_sql" }],
    schedules: [{ ...baseSchedule }],
    account_refs: [{ id: "account-1", company_id: "company-1", platform: "gmail", status: "active", verification_status: "verified" }],
    service_identity: { configured: true, source: "test" },
    canonical_company_id: "company-1",
    canonical_authority_fresh: true,
    source_company_id: "company-1",
    source_authority_fresh: true,
    worker_company_id: "company-1",
    worker_authority_fresh: true,
    runtime_company_id: "company-1",
    runtime_authority_fresh: true,
    provider_authority_fresh: true,
    browser_authority_fresh: true,
    provider_receipt_contract_ready: true,
    source_sync_contract_ready: true,
    reconciliation_contract_ready: true,
    cleanup_contract_ready: true,
    brief_home_readback_available: true,
    brief_delivery_configured: true,
    chat_consultation_available: true,
    chat_read_only_demo_available: true,
    chat_approval_preview_available: true,
    chat_registration_ready: true,
    graph_receipt_status: "none",
    database: {
      backend: "sqlite",
      before: { file_id: "dev:1", sha256: "same", size_bytes: 10, mtime_ms: 1 },
      after: { file_id: "dev:1", sha256: "same", size_bytes: 10, mtime_ms: 1 },
      integrity: "ok",
      stable: true
    },
    ...overrides
  };
}

test("company readiness never selects a canonical company from local diagnostic rows", () => {
  const result = buildCompanyBindingReadinessV1(input({
    canonical_company_id: null,
    canonical_authority_fresh: false
  }));

  assert.equal(result.status, "blocked");
  assert.equal(result.production_ready, false);
  assert.equal(result.canonical_company_id, null);
  assert.equal(result.scope.canonical_authority.selected, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === "protected_aos_company_and_endpoint_not_owner_selected"));
  assert.equal(result.mutation.company_selected, false);
  assert.equal(result.external_action_executed, false);
});

test("company readiness reports trigger and local diagnostic scope mismatch", () => {
  const result = buildCompanyBindingReadinessV1(input({
    trigger_company_id: "codex-company",
    local_companies: [{ company_id: "local-company", automation_count: 1, provenance: "test_sql" }],
    canonical_company_id: null,
    canonical_authority_fresh: false
  }));

  assert.equal(result.scope.status, "mismatch_unreconciled");
  assert.ok(result.blockers.some((blocker) => blocker.code === "aos_local_diagnostic_scope_not_authorized_for_claim"));
  assert.ok(result.blockers.some((blocker) => blocker.code === "codex_trigger_aos_company_and_project_binding_not_reconciled"));
});

test("company readiness exposes missing identity and unverified account refs without values", () => {
  const result = buildCompanyBindingReadinessV1(input({
    service_identity: { configured: false, source: "missing" },
    account_refs: [{ id: "account-1", company_id: "company-1", platform: "gmail", status: "configured", verification_status: "pending" }]
  }));

  assert.ok(result.blockers.some((blocker) => blocker.code === "durable_scheduler_service_user_id_missing"));
  assert.ok(result.blockers.some((blocker) => blocker.code === "current_aos_account_refs_unverified"));
  assert.equal(result.account_refs.values_exposed, false);
  assert.equal(Object.hasOwn(result.account_refs.rows[0] ?? {}, "account_ref"), false);
});

test("stale schedule and stale graph receipt stay blocked and cannot materialize", () => {
  const result = buildCompanyBindingReadinessV1(input({
    graph_receipt_status: "stale_or_tampered",
    schedules: [{ ...baseSchedule, next_run_at: "2026-09-02T00:00:00.000Z" }]
  }));

  assert.equal(result.schedules[0].overdue, true);
  assert.equal(result.schedules[0].materialization_decision, "blocked");
  assert.ok(result.schedules[0].exact_blockers.includes("scheduler_overdue_occurrence_policy_required"));
  assert.equal(result.graph_receipt.accepted_as_authority, false);
  assert.equal(result.graph_receipt.replay_allowed, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === "stale_graph_receipt_not_authoritative"));
  assert.equal(result.mutation.schedule_materialized, false);
});

test("synthetic fully fresh company binding can satisfy the readiness contract", () => {
  const result = buildCompanyBindingReadinessV1(input());

  assert.equal(result.status, "ready");
  assert.equal(result.production_ready, true);
  assert.equal(result.canonical_company_id, "company-1");
  assert.equal(result.scope.status, "matched");
  assert.deepEqual(result.blockers, []);
  assert.equal(result.external_action_executed, false);
  assert.equal(result.mutation.provider_called, false);
  assert.match(result.next_action, /vertical Run/);
});

test("local-only schedules stay materialization-eligible when provider authority is not ready", () => {
  const result = buildCompanyBindingReadinessV1(input({
    schedules: [{ ...baseSchedule, execution_lane: "local_only" }],
    provider_authority_fresh: false,
    browser_authority_fresh: false,
    provider_receipt_contract_ready: false,
    source_sync_contract_ready: false,
    reconciliation_contract_ready: false,
    cleanup_contract_ready: false,
    account_refs: []
  }));

  assert.equal(result.status, "blocked");
  assert.equal(result.production_ready, false);
  assert.equal(result.schedules[0]?.execution_lane, "local_only");
  assert.equal(result.schedules[0]?.materialization_eligible, true);
  assert.deepEqual(result.schedules[0]?.exact_blockers, []);
  assert.ok(result.blockers.some((blocker) => blocker.code === "fresh_selected_provider_and_browser_authority_missing"));
  assert.ok(result.blockers.some((blocker) => blocker.code === "current_aos_account_refs_missing"));
});

import { createHash } from "node:crypto";
import type { CompanyBindingReconciliationReport } from "./companyBindingReconciliation.js";

export const CANONICAL_COMPANY_CONSULTATION_SCHEMA_V1 = "canonical_company_consultation.v1" as const;

type ConsultationSnapshot = {
  snapshot_id: string;
  captured_at: string;
  provenance: string;
  fresh: boolean;
};

export type CanonicalCompanyConsultationInput = {
  reconciliation: CompanyBindingReconciliationReport;
  snapshot: ConsultationSnapshot;
};

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safeText(value: string | null | undefined, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 240) : fallback;
}

function candidateProjection(candidate: CompanyBindingReconciliationReport["candidates"][number]) {
  return {
    company_id: candidate.company_id,
    status: candidate.status,
    decision: candidate.decision,
    reason_codes: [...candidate.reason_codes],
    provenance: {
      trigger: candidate.trigger.observed ? "codex_app_registered_automation_readonly_readback" : null,
      local: candidate.local.provenance
    },
    counts: {
      registered_automations: candidate.trigger.registered_count,
      local_automations: candidate.local.automation_count,
      schedules: candidate.local.schedule_ids.length
    },
    references: {
      trigger_source_ids: [...candidate.trigger.source_ids],
      local_automation_ids: [...candidate.local.automation_ids],
      local_schedule_ids: [...candidate.local.schedule_ids]
    }
  };
}

function blockedDownstream(exactBlocker: string) {
  return {
    schedule_activation: { status: "blocked" as const, exact_blocker: exactBlocker },
    brief: {
      preview_available: true,
      generation_status: "read_only_preview_available" as const,
      delivery_status: "blocked" as const,
      exact_blocker: exactBlocker
    },
    provider_receipt: { status: "not_attempted" as const, exact_blocker: exactBlocker },
    source_sync: { status: "not_attempted" as const, exact_blocker: exactBlocker },
    reconciliation: { status: "not_attempted" as const, exact_blocker: exactBlocker },
    cleanup: { status: "not_attempted" as const, exact_blocker: exactBlocker }
  };
}

function selectedDownstream() {
  return {
    schedule_activation: { status: "pending_readiness" as const, exact_blocker: "downstream_readiness_gates_pending" },
    brief: {
      preview_available: true,
      generation_status: "read_only_preview_available" as const,
      delivery_status: "home_only" as const,
      exact_blocker: null
    },
    provider_receipt: { status: "not_attempted" as const, exact_blocker: "provider_receipt_contract_not_proven" },
    source_sync: { status: "not_attempted" as const, exact_blocker: "source_sync_contract_not_proven" },
    reconciliation: { status: "not_attempted" as const, exact_blocker: "reconciliation_contract_not_proven" },
    cleanup: { status: "not_attempted" as const, exact_blocker: "cleanup_contract_not_proven" }
  };
}

/**
 * Project a fresh reconciliation into the safe Chat consultation surface.
 * This is deliberately read-only: it never applies a candidate or authorizes
 * a schedule, provider, Brief delivery, or other external effect.
 */
export function buildCanonicalCompanyConsultationV1(input: CanonicalCompanyConsultationInput) {
  const reconciliation = input.reconciliation;
  const snapshot = input.snapshot;
  const inputFingerprint = fingerprint({
    schema: reconciliation.schema,
    generated_at: reconciliation.generated_at,
    requested_company_id: reconciliation.requested_company_id,
    sources: reconciliation.sources,
    candidates: reconciliation.candidates,
    exact_blocker: reconciliation.exact_blocker
  });
  const freshnessValid = snapshot.fresh === true
    && reconciliation.schema === "company_binding_reconciliation.v1";
  const reconciliationBlocker = freshnessValid
    ? reconciliation.exact_blocker
    : "company_binding_reconciliation_stale_or_missing";
  const selected = freshnessValid
    && reconciliation.selection.selected === true
    && typeof reconciliation.canonical_company_id === "string";
  const exactBlocker = selected ? null : reconciliationBlocker;
  const candidates = freshnessValid ? reconciliation.candidates.map(candidateProjection) : [];

  return {
    schema: CANONICAL_COMPANY_CONSULTATION_SCHEMA_V1,
    status: selected ? "ready" as const : "blocked" as const,
    selection_state: selected ? "selected" as const : "unresolved" as const,
    snapshot: {
      snapshot_id: safeText(snapshot.snapshot_id, "missing_snapshot_id"),
      captured_at: safeText(snapshot.captured_at, reconciliation.generated_at),
      provenance: safeText(snapshot.provenance, "company_binding_reconciliation_readonly_readback"),
      fresh: freshnessValid,
      input_fingerprint: inputFingerprint
    },
    canonical_company_id: selected ? reconciliation.canonical_company_id : null,
    candidates,
    owner_decision: {
      required: !selected,
      decision_type: "canonical_company_mapping",
      recommended_candidate_company_id: selected ? reconciliation.canonical_company_id : null,
      available_candidate_company_ids: candidates.map((candidate) => candidate.company_id),
      reason: selected
        ? "Owner-selected mapping is applied; provider, browser, and same-run completion gates remain separate."
        : "Owner must explicitly identify the protected AOS company/project mapping; no candidate is recommended from recency, majority, or source order."
    },
    downstream: selected ? selectedDownstream() : blockedDownstream(exactBlocker ?? "company_binding_reconciliation_stale_or_missing"),
    chat: {
      consultation_available: freshnessValid,
      read_only_demo_available: freshnessValid,
      approval_preview_available: freshnessValid,
      company_scoped_registration_ready: selected,
      registration_status: selected ? "ready" as const : "blocked" as const,
      exact_blocker: exactBlocker
    },
    exact_blocker: exactBlocker,
    sensitive_values_exposed: false,
    external_action_executed: false,
    mutation: {
      canonical_company_selected: selected,
      trigger_rewired: false,
      schedules_materialized: false,
      provider_called: false,
      browser_started: false,
      brief_delivered: false,
      chat_registration_changed: false
    },
    next_action: selected
      ? "Chat相談・read-only実演を会社scope内で進め、外部効果はworkflow別の承認と同一Run証跡が揃うまで開始しない。"
      : "Owner chooses the protected company mapping in Chat; keep this consultation read-only until that decision is explicitly applied and a fresh same-run readback succeeds."
  };
}

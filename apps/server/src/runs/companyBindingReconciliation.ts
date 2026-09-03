export const COMPANY_BINDING_RECONCILIATION_SCHEMA_V1 = "company_binding_reconciliation.v1" as const;

const COMPANY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;

export type CompanyBindingReconciliationTriggerInput = {
  id: string;
  name?: string | null;
  status?: string | null;
  rrule?: string | null;
  company_id?: string | null;
  automation_id?: string | null;
  source_kind?: string;
  provenance?: string;
};

export type CompanyBindingReconciliationLocalCompanyInput = {
  company_id: string;
  name?: string | null;
  status?: string | null;
  automation_count: number;
  automation_ids?: readonly string[];
  schedule_ids?: readonly string[];
  provenance?: string;
};

export type CompanyBindingReconciliationReferenceInput = {
  service_identity_configured?: boolean;
  service_identity_source?: string | null;
  account_ref_count?: number;
  verified_account_ref_count?: number;
  account_platforms?: readonly string[];
  provider_authority_fresh?: boolean;
  browser_authority_fresh?: boolean;
  brief_home_readback_available?: boolean;
  brief_delivery_configured?: boolean;
  chat_consultation_available?: boolean;
  chat_read_only_demo_available?: boolean;
  chat_approval_preview_available?: boolean;
  chat_registration_ready?: boolean;
};

export type CompanyBindingReconciliationInput = {
  now: string;
  requested_company_id?: string | null;
  trigger_company_id?: string | null;
  trigger_provenance?: string;
  trigger_sources: readonly CompanyBindingReconciliationTriggerInput[];
  local_companies: readonly CompanyBindingReconciliationLocalCompanyInput[];
  reference_observations?: Readonly<Record<string, CompanyBindingReconciliationReferenceInput>>;
  explicit_authority?: {
    company_id?: string | null;
    fresh?: boolean;
    source?: string | null;
    /** True only after the Owner's explicit mapping has been persisted. */
    applied?: boolean;
  };
};

export type ConfiguredCanonicalCompanyAuthority = {
  company_id: string;
  endpoint: string;
  fresh: boolean;
  applied: boolean;
  source: string;
};

type CandidateDecision = "canonical_candidate" | "requires_user_decision";
type CandidateStatus = "matched" | "trigger_only" | "local_only" | "unobserved" | "conflict";

type SafeReference = {
  service_identity: { configured: boolean; source: string };
  account_refs: { count: number; verified_count: number; platforms: string[] };
  provider_authority_fresh: boolean;
  browser_authority_fresh: boolean;
  brief: { home_readback_available: boolean; delivery_configured: boolean };
  chat: {
    consultation_available: boolean;
    read_only_demo_available: boolean;
    approval_preview_available: boolean;
    registration_ready: boolean;
  };
};

function normalizeId(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !COMPANY_ID.test(value)) return null;
  return value;
}

/**
 * Read the explicit, non-secret Owner choice installed for this AOS host.
 * Missing or non-loopback configuration is intentionally treated as absent;
 * registered-trigger and local SQL observations never select a company.
 */
export function readConfiguredCanonicalCompanyAuthority(env: NodeJS.ProcessEnv = process.env): ConfiguredCanonicalCompanyAuthority | null {
  const companyId = normalizeId(env.AOS_CANONICAL_COMPANY_ID);
  const rawEndpoint = typeof env.AOS_CANONICAL_ENDPOINT === "string" ? env.AOS_CANONICAL_ENDPOINT.trim() : "";
  if (!companyId || !rawEndpoint) return null;
  let endpoint: URL;
  try {
    endpoint = new URL(rawEndpoint);
  } catch {
    return null;
  }
  if (endpoint.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(endpoint.hostname)) return null;
  const origin = endpoint.origin;
  return {
    company_id: companyId,
    endpoint: origin,
    fresh: env.AOS_CANONICAL_AUTHORITY_FRESH === "1",
    applied: env.AOS_CANONICAL_SELECTION_APPLIED === "1",
    source: `owner_selected_endpoint:${origin}`
  };
}

function normalizeText(value: string | null | undefined, limit = 1000): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text.slice(0, limit) : null;
}

function safeList(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim().slice(0, 200)))].sort();
}

function safeNumber(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function referenceFor(input: CompanyBindingReconciliationReferenceInput | undefined): SafeReference {
  const accountCount = safeNumber(input?.account_ref_count);
  return {
    service_identity: {
      configured: input?.service_identity_configured === true,
      source: normalizeText(input?.service_identity_source) ?? "missing"
    },
    account_refs: {
      count: accountCount,
      verified_count: Math.min(accountCount, safeNumber(input?.verified_account_ref_count)),
      platforms: safeList(input?.account_platforms)
    },
    provider_authority_fresh: input?.provider_authority_fresh === true,
    browser_authority_fresh: input?.browser_authority_fresh === true,
    brief: {
      home_readback_available: input?.brief_home_readback_available !== false,
      delivery_configured: input?.brief_delivery_configured === true
    },
    chat: {
      consultation_available: input?.chat_consultation_available !== false,
      read_only_demo_available: input?.chat_read_only_demo_available !== false,
      approval_preview_available: input?.chat_approval_preview_available !== false,
      registration_ready: input?.chat_registration_ready === true
    }
  };
}

/**
 * Compare Codex trigger metadata and AOS-local company observations without
 * selecting a canonical company. Only a fresh explicit authority may produce
 * a `canonical_candidate`; it is still not applied and never grants effect
 * permission.
 */
export function buildCompanyBindingReconciliationV1(input: CompanyBindingReconciliationInput) {
  const triggerCompanyId = normalizeId(input.trigger_company_id);
  const requestedCompanyId = normalizeId(input.requested_company_id);
  const triggerSources = input.trigger_sources.map((source) => ({
    id: normalizeText(source.id, 200) ?? "invalid_trigger_id",
    name: normalizeText(source.name, 240),
    status: normalizeText(source.status, 80),
    rrule: normalizeText(source.rrule, 240),
    company_id: normalizeId(source.company_id),
    automation_id: normalizeId(source.automation_id),
    source_kind: normalizeText(source.source_kind, 120) ?? "codex_app_registered_automation",
    provenance: normalizeText(source.provenance, 200) ?? input.trigger_provenance ?? "registered_trigger_readback"
  })).sort((left, right) => left.id.localeCompare(right.id));
  const localCompanies = input.local_companies.map((company) => ({
    company_id: normalizeId(company.company_id),
    name: normalizeText(company.name, 240),
    status: normalizeText(company.status, 80),
    automation_count: safeNumber(company.automation_count),
    automation_ids: safeList(company.automation_ids),
    schedule_ids: safeList(company.schedule_ids),
    provenance: normalizeText(company.provenance, 200) ?? "local_diagnostic_sql_readback"
  })).filter((company) => company.company_id !== null) as Array<{
    company_id: string;
    name: string | null;
    status: string | null;
    automation_count: number;
    automation_ids: string[];
    schedule_ids: string[];
    provenance: string;
  }>;

  const candidateIds = new Set<string>();
  for (const id of [requestedCompanyId, triggerCompanyId]) if (id) candidateIds.add(id);
  for (const source of triggerSources) if (source.company_id) candidateIds.add(source.company_id);
  for (const company of localCompanies) candidateIds.add(company.company_id);

  const localById = new Map(localCompanies.map((company) => [company.company_id, company]));
  const triggerByCompany = new Map<string, typeof triggerSources>();
  for (const source of triggerSources) {
    if (!source.company_id) continue;
    const rows = triggerByCompany.get(source.company_id) ?? [];
    rows.push(source);
    triggerByCompany.set(source.company_id, rows);
  }

  const candidates = [...candidateIds].sort().map((companyId) => {
    const local = localById.get(companyId) ?? null;
    const triggers = triggerByCompany.get(companyId) ?? [];
    const triggerAutomationIds = safeList(triggers.map((source) => source.automation_id).filter((id): id is string => id !== null));
    const localAutomationIds = local?.automation_ids ?? [];
    const hasTriggerObservation = triggers.length > 0 || triggerCompanyId === companyId;
    const hasLocalObservation = local !== null;
    const automationReferencesMatch = hasTriggerObservation && hasLocalObservation
      ? triggerAutomationIds.length === 0 || localAutomationIds.length === 0
        ? null
        : triggerAutomationIds.some((id) => localAutomationIds.includes(id))
      : null;
    const companyStatus: CandidateStatus = hasTriggerObservation && hasLocalObservation
      ? automationReferencesMatch === false ? "conflict" : "matched"
      : hasTriggerObservation ? "trigger_only" : hasLocalObservation ? "local_only" : "unobserved";
    const reasonCodes: string[] = [];
    if (companyStatus === "trigger_only") reasonCodes.push("trigger_company_not_observed_in_local_aos");
    if (companyStatus === "local_only") reasonCodes.push("local_company_not_observed_in_registered_triggers");
    if (companyStatus === "conflict") reasonCodes.push("automation_reference_mismatch");
    if (requestedCompanyId && requestedCompanyId !== companyId) reasonCodes.push("outside_requested_company_scope");
    if (candidateIds.size > 1) reasonCodes.push("multiple_company_candidates_observed");
    reasonCodes.sort();
    return {
      company_id: companyId,
      decision: "requires_user_decision" as CandidateDecision,
      status: companyStatus,
      reason_codes: reasonCodes,
      trigger: {
        observed: hasTriggerObservation,
        registered_count: triggers.length,
        automation_ids: triggerAutomationIds,
        source_ids: triggers.map((source) => source.id)
      },
      local: {
        observed: hasLocalObservation,
        name: local?.name ?? null,
        status: local?.status ?? null,
        automation_count: local?.automation_count ?? 0,
        automation_ids: localAutomationIds,
        schedule_ids: local?.schedule_ids ?? [],
        provenance: local?.provenance ?? null
      },
      comparison: {
        trigger_company_id_matches: triggerCompanyId === companyId,
        automation_reference_match: automationReferencesMatch,
        schedule_count: local?.schedule_ids.length ?? 0
      },
      references: referenceFor(input.reference_observations?.[companyId])
    };
  });

  const authorityCompanyId = normalizeId(input.explicit_authority?.company_id);
  const authorityFresh = input.explicit_authority?.fresh === true;
  const authorityCandidate = authorityFresh && authorityCompanyId !== null && candidateIds.has(authorityCompanyId);
  const canonicalCandidate = authorityCandidate ? authorityCompanyId : null;
  const canonicalSelected = authorityCandidate && input.explicit_authority?.applied === true;
  for (const candidate of candidates) {
    if (candidate.company_id === canonicalCandidate) {
      candidate.decision = "canonical_candidate";
      candidate.reason_codes = [...candidate.reason_codes, "fresh_explicit_authority_observed"].sort();
    }
  }

  const exactBlocker = canonicalSelected
    ? null
    : canonicalCandidate === null ? "canonical_company_unresolved" : "canonical_company_selection_not_applied";
  return {
    schema: COMPANY_BINDING_RECONCILIATION_SCHEMA_V1,
    generated_at: normalizeText(input.now) ?? new Date(0).toISOString(),
    status: canonicalSelected ? "matched" : canonicalCandidate === null ? "requires_user_decision" : "candidate_identified",
    requested_company_id: requestedCompanyId,
    canonical_company_id: canonicalSelected ? canonicalCandidate : null,
    selection: {
      selected: canonicalSelected,
      canonical_candidate_company_id: canonicalCandidate,
      authority: {
        fresh: authorityFresh,
        company_id: authorityCompanyId,
        source: normalizeText(input.explicit_authority?.source, 240)
      },
      reason: canonicalSelected
        ? "Owner-selected company and endpoint mapping is applied; fresh downstream authority remains separate."
        : canonicalCandidate === null
        ? "A fresh explicit owner authority is required; observed recency or majority never selects a company."
        : "A fresh explicit authority identifies a candidate, but selection remains an unperformed owner action."
    },
    sources: {
      trigger: {
        company_id: triggerCompanyId,
        provenance: normalizeText(input.trigger_provenance, 240) ?? "registered_trigger_readback",
        entries: triggerSources
      },
      local: {
        provenance: "local_sql_diagnostic_readback",
        companies: localCompanies
      }
    },
    candidates,
    exact_blocker: exactBlocker,
    sensitive_values_exposed: false,
    external_action_executed: false,
    mutation: {
      canonical_company_selected: canonicalSelected,
      trigger_rewired: false,
      schedules_materialized: false,
      provider_called: false,
      browser_started: false,
      brief_delivered: false,
      chat_registration_changed: false
    },
    next_action: canonicalSelected
      ? "Run the fresh company-scoped no-effect readiness and clear provider, browser, same-run proof, Brief, and Chat gates separately."
      : canonicalCandidate === null
      ? "Owner confirms the protected AOS company/project mapping from the listed sources; do not auto-select or materialize schedules."
      : "Owner explicitly applies the identified candidate in a separate authorized change, then perform a fresh same-run readback."
  };
}

export type CompanyBindingReconciliationReport = ReturnType<typeof buildCompanyBindingReconciliationV1>;

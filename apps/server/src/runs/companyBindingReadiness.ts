import { evaluateCanonicalCompanyBinding } from "./canonicalCompanyBinding.js";

export const COMPANY_BINDING_READINESS_SCHEMA_V1 = "company_binding_readiness.v1" as const;
export const DEFAULT_CODEX_TRIGGER_COMPANY_ID = "company_2560580981cedfd106b66245" as const;

const COMPANY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;

export type CompanyBindingReadinessScheduleInput = {
  id: string;
  company_id: string;
  automation_id: string;
  execution_lane?: "local_only" | "provider_browser";
  automation_name?: string | null;
  kind: string;
  expression: string | null;
  timezone: string;
  enabled: boolean | number;
  status: string;
  revision: number;
  next_run_at: string | null;
  last_run_at?: string | null;
  catch_up_policy?: "skip" | "coalesce_one" | "explicit_occurrence" | null;
};

export type CompanyBindingReadinessAccountRefInput = {
  id: string;
  company_id: string;
  platform: string;
  status: string;
  verification_status: string;
};

export type CompanyBindingReadinessDatabaseFingerprint = {
  file_id?: string | null;
  size_bytes?: number | null;
  mtime_ms?: number | null;
  sha256?: string | null;
};

export type CompanyBindingReadinessDatabaseInput = {
  backend: "sqlite" | "postgres";
  path?: string | null;
  before?: CompanyBindingReadinessDatabaseFingerprint | null;
  after?: CompanyBindingReadinessDatabaseFingerprint | null;
  integrity?: string | null;
  counts?: Record<string, number | null>;
  stable?: boolean | null;
};

export type CompanyBindingReadinessInput = {
  now: string;
  trigger_company_id?: string | null;
  trigger_provenance?: string;
  local_companies: Array<{ company_id: string; automation_count: number; provenance?: string }>;
  schedules: CompanyBindingReadinessScheduleInput[];
  account_refs?: CompanyBindingReadinessAccountRefInput[];
  service_identity?: { configured: boolean; source?: string };
  canonical_company_id?: string | null;
  canonical_authority_fresh?: boolean;
  source_company_id?: string | null;
  source_authority_fresh?: boolean;
  worker_company_id?: string | null;
  worker_authority_fresh?: boolean;
  runtime_company_id?: string | null;
  runtime_authority_fresh?: boolean;
  provider_authority_fresh?: boolean;
  browser_authority_fresh?: boolean;
  provider_receipt_contract_ready?: boolean;
  source_sync_contract_ready?: boolean;
  reconciliation_contract_ready?: boolean;
  cleanup_contract_ready?: boolean;
  brief_home_readback_available?: boolean;
  brief_delivery_configured?: boolean;
  chat_consultation_available?: boolean;
  chat_read_only_demo_available?: boolean;
  chat_approval_preview_available?: boolean;
  chat_registration_ready?: boolean;
  graph_receipt_status?: "none" | "fresh" | "stale_or_tampered";
  database?: CompanyBindingReadinessDatabaseInput;
};

type Blocker = {
  code: string;
  scope: string;
  required_evidence: string;
};

function normalizeCompanyId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  return COMPANY_ID.test(candidate) ? candidate : null;
}

function normalizedText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  return candidate || null;
}

function boolish(value: boolean | number): boolean {
  return value === true || value === 1;
}

function verifiedAccountRef(row: CompanyBindingReadinessAccountRefInput): boolean {
  // The company-connection contract uses `verified` as its lifecycle status;
  // older scheduler fixtures use `active`. Both are valid only with the
  // separate verified readback flag.
  return (row.status === "active" || row.status === "verified") && row.verification_status === "verified";
}

function isOverdue(nextRunAt: string | null, now: string): boolean {
  if (!nextRunAt) return false;
  const next = Date.parse(nextRunAt);
  const current = Date.parse(now);
  return Number.isFinite(next) && Number.isFinite(current) && next <= current;
}

function addBlocker(target: Blocker[], blocker: Blocker): void {
  if (target.some((item) => item.code === blocker.code && item.scope === blocker.scope)) return;
  target.push(blocker);
}

function stableDatabaseReadback(database: CompanyBindingReadinessDatabaseInput | undefined): boolean | null {
  if (!database) return null;
  if (database.stable !== undefined && database.stable !== null) return database.stable;
  const before = database.before;
  const after = database.after;
  if (!before || !after) return null;
  if (before.file_id && after.file_id && before.file_id !== after.file_id) return false;
  if (before.sha256 && after.sha256) return before.sha256 === after.sha256;
  if (before.size_bytes !== undefined && after.size_bytes !== undefined && before.size_bytes !== after.size_bytes) return false;
  if (before.mtime_ms !== undefined && after.mtime_ms !== undefined && before.mtime_ms !== after.mtime_ms) return false;
  return null;
}

/**
 * Build the one read-only readiness contract for company binding.
 *
 * This function observes candidate scopes; it never chooses a canonical
 * company, rewires triggers, materializes schedules, or grants effect
 * authority. A fully synthetic fixture can become ready only when every
 * required fresh observation is explicitly supplied by its caller.
 */
export function buildCompanyBindingReadinessV1(input: CompanyBindingReadinessInput): {
  schema: typeof COMPANY_BINDING_READINESS_SCHEMA_V1;
  generated_at: string;
  status: "ready" | "blocked";
  production_ready: boolean;
  canonical_company_id: string | null;
  scope: {
    status: "matched" | "mismatch_unreconciled" | "canonical_unselected" | "unknown";
    trigger_company_id: string | null;
    trigger_provenance: string;
    local_companies: Array<{ company_id: string; automation_count: number; provenance: string }>;
    canonical_authority: { selected: boolean; fresh: boolean; company_id: string | null };
  };
  service_identity: { configured: boolean; source: string };
  account_refs: {
    count: number;
    rows: Array<{ id: string; company_id: string; platform: string; status: string; verification_status: string }>;
    values_exposed: false;
  };
  schedules: Array<{
    id: string;
    company_id: string;
    automation_id: string;
    execution_lane: "local_only" | "provider_browser";
    automation_name: string | null;
    kind: string;
    expression: string | null;
    timezone: string;
    enabled: boolean;
    status: string;
    revision: number;
    next_run_at: string | null;
    last_run_at: string | null;
    overdue: boolean;
    catch_up_policy: string | null;
    materialization_eligible: boolean;
    materialization_decision: "eligible" | "blocked";
    exact_blockers: string[];
  }>;
  readiness: {
    provider_receipt: { ready: boolean; exact_blocker: string | null; required_evidence: string };
    source_sync: { ready: boolean; exact_blocker: string | null; required_evidence: string };
    reconciliation: { ready: boolean; exact_blocker: string | null; required_evidence: string };
    cleanup: { ready: boolean; exact_blocker: string | null; required_evidence: string };
    provider_authority_fresh: boolean;
    browser_authority_fresh: boolean;
    brief: {
      home_readback_available: boolean;
      delivery_configured: boolean;
      external_notification_sent: false;
      exact_blocker: string | null;
    };
    chat: {
      consultation_available: boolean;
      read_only_demo_available: boolean;
      approval_preview_available: boolean;
      company_scoped_registration_ready: boolean;
      exact_blocker: string | null;
    };
  };
  graph_receipt: { status: "none" | "fresh" | "stale_or_tampered"; accepted_as_authority: false; replay_allowed: false; exact_blocker: string | null };
  database: (CompanyBindingReadinessDatabaseInput & { stable: boolean | null }) | null;
  blockers: Blocker[];
  external_action_executed: false;
  mutation: {
    company_selected: false;
    trigger_rewired: false;
    schedule_materialized: false;
    run_created: false;
    provider_called: false;
    browser_started: false;
    notification_sent: false;
  };
  next_action: string;
} {
  const now = normalizedText(input.now) ?? new Date(0).toISOString();
  const triggerCompanyId = normalizeCompanyId(input.trigger_company_id);
  const canonicalCompanyId = normalizeCompanyId(input.canonical_company_id);
  const localCompanies = [...input.local_companies]
    .map((row) => ({
      company_id: normalizeCompanyId(row.company_id) ?? "invalid_company_id",
      automation_count: Number.isSafeInteger(row.automation_count) && row.automation_count >= 0 ? row.automation_count : 0,
      provenance: normalizedText(row.provenance) ?? "local_diagnostic_readback"
    }))
    .sort((a, b) => a.company_id.localeCompare(b.company_id));
  const localCompanyIds = new Set(localCompanies.map((row) => row.company_id).filter((id) => id !== "invalid_company_id"));
  const serviceIdentity = {
    configured: input.service_identity?.configured === true,
    source: normalizedText(input.service_identity?.source) ?? (input.service_identity?.configured === true ? "environment" : "missing")
  };
  const authorityFresh = input.canonical_authority_fresh === true;
  const sourceCompanyId = normalizeCompanyId(input.source_company_id);
  const workerCompanyId = normalizeCompanyId(input.worker_company_id);
  const runtimeCompanyId = normalizeCompanyId(input.runtime_company_id);
  const binding = evaluateCanonicalCompanyBinding({
    authorityCompanyId: canonicalCompanyId,
    authorityFresh,
    sourceCompanyId,
    sourceFresh: input.source_authority_fresh === true,
    workerCompanyId,
    workerFresh: input.worker_authority_fresh === true,
    runtimeCompanyId,
    runtimeFresh: input.runtime_authority_fresh === true
  });
  const scopeStatus = canonicalCompanyId === null
    ? triggerCompanyId && !localCompanyIds.has(triggerCompanyId)
      ? "mismatch_unreconciled"
      : "canonical_unselected"
    : binding.status === "matched"
      ? "matched"
      : binding.status === "mismatch"
        ? "mismatch_unreconciled"
        : "unknown";
  const blockers: Blocker[] = [];
  if (canonicalCompanyId === null) {
    addBlocker(blockers, {
      code: "protected_aos_company_and_endpoint_not_owner_selected",
      scope: "company_binding",
      required_evidence: "Owner-authorized protected AOS company/endpoint readback"
    });
  }
  if (triggerCompanyId && !localCompanyIds.has(triggerCompanyId)) {
    addBlocker(blockers, {
      code: "aos_local_diagnostic_scope_not_authorized_for_claim",
      scope: "company_binding",
      required_evidence: "Fresh protected AOS schedule readback for the observed Codex trigger company"
    });
    addBlocker(blockers, {
      code: "codex_trigger_aos_company_and_project_binding_not_reconciled",
      scope: "company_binding",
      required_evidence: "Owner-confirmed Codex trigger to AOS company/project mapping with source hashes"
    });
  }
  if (binding.exactBlocker) {
    addBlocker(blockers, {
      code: binding.exactBlocker,
      scope: "company_binding",
      required_evidence: "Fresh matching authority, source, worker, and runtime company observations"
    });
  }
  if (!serviceIdentity.configured) {
    addBlocker(blockers, {
      code: "durable_scheduler_service_user_id_missing",
      scope: "scheduler",
      required_evidence: "Configured service identity and active operator membership readback"
    });
  }
  const accountRefs = (input.account_refs ?? []).map((row) => ({
    id: normalizedText(row.id) ?? "invalid_account_ref_id",
    company_id: normalizeCompanyId(row.company_id) ?? "invalid_company_id",
    platform: normalizedText(row.platform) ?? "unknown",
    status: normalizedText(row.status) ?? "unknown",
    verification_status: normalizedText(row.verification_status) ?? "unknown"
  }));
  if (accountRefs.length === 0) {
    addBlocker(blockers, {
      code: "current_aos_account_refs_missing",
      scope: "account_binding",
      required_evidence: "Company-scoped provider account reference rows with verification status"
    });
  } else if (accountRefs.some((row) => !verifiedAccountRef(row))) {
    addBlocker(blockers, {
      code: "current_aos_account_refs_unverified",
      scope: "account_binding",
      required_evidence: "Fresh active and verified account reference readback for each workflow"
    });
  }
  const graphReceiptStatus = input.graph_receipt_status ?? "none";
  const graphReceiptBlocker = graphReceiptStatus === "stale_or_tampered" ? "stale_graph_receipt_not_authoritative" : null;
  if (graphReceiptBlocker) {
    addBlocker(blockers, {
      code: graphReceiptBlocker,
      scope: "orchestration",
      required_evidence: "A new current-turn route receipt; never reuse the stale receipt"
    });
  }
  if (input.provider_authority_fresh !== true || input.browser_authority_fresh !== true) {
    addBlocker(blockers, {
      code: "fresh_selected_provider_and_browser_authority_missing",
      scope: "provider_browser",
      required_evidence: "Fresh selected provider authority and the workflow's canonical browser lane readback"
    });
  }

  const scheduleRows = input.schedules.map((schedule) => {
    const overdue = isOverdue(schedule.next_run_at, now);
    const catchUpPolicy = schedule.catch_up_policy ?? null;
    const executionLane: "local_only" | "provider_browser" = schedule.execution_lane === "local_only" ? "local_only" : "provider_browser";
    const exactBlockers: string[] = [];
    if (!boolish(schedule.enabled) || schedule.status !== "active") exactBlockers.push("schedule_not_active");
    if (overdue && !catchUpPolicy) {
      exactBlockers.push("scheduler_overdue_occurrence_policy_required");
      addBlocker(blockers, {
        code: "scheduler_overdue_occurrence_policy_required",
        scope: `schedule:${schedule.id}`,
        required_evidence: "Owner-selected skip, one-item coalesce, or explicit occurrence policy"
      });
    }
    for (const blocker of blockers.filter((item) => {
      if (item.scope === "provider_browser" || item.scope === "account_binding") return executionLane !== "local_only";
      return item.scope === "company_binding" || item.scope === "scheduler";
    })) {
      if (!exactBlockers.includes(blocker.code)) exactBlockers.push(blocker.code);
    }
    const eligible = exactBlockers.length === 0;
    return {
      id: normalizedText(schedule.id) ?? "invalid_schedule_id",
      company_id: normalizeCompanyId(schedule.company_id) ?? "invalid_company_id",
      automation_id: normalizedText(schedule.automation_id) ?? "invalid_automation_id",
      execution_lane: executionLane,
      automation_name: normalizedText(schedule.automation_name) ?? null,
      kind: normalizedText(schedule.kind) ?? "unknown",
      expression: normalizedText(schedule.expression) ?? null,
      timezone: normalizedText(schedule.timezone) ?? "unknown",
      enabled: boolish(schedule.enabled),
      status: normalizedText(schedule.status) ?? "unknown",
      revision: Number.isSafeInteger(schedule.revision) && schedule.revision >= 0 ? schedule.revision : 0,
      next_run_at: schedule.next_run_at,
      last_run_at: schedule.last_run_at ?? null,
      overdue,
      catch_up_policy: catchUpPolicy,
      materialization_eligible: eligible,
      materialization_decision: (eligible ? "eligible" : "blocked") as "eligible" | "blocked",
      exact_blockers: [...new Set(exactBlockers)]
    };
  });

  const providerReceiptReady = input.provider_receipt_contract_ready === true;
  const sourceSyncReady = input.source_sync_contract_ready === true;
  const reconciliationReady = input.reconciliation_contract_ready === true;
  const cleanupReady = input.cleanup_contract_ready === true;
  const evidenceRows = {
    provider_receipt: { ready: providerReceiptReady, exact_blocker: providerReceiptReady ? null : "provider_receipt_contract_not_proven", required_evidence: "Same-run provider receipt bound to run/account/target/payload" },
    source_sync: { ready: sourceSyncReady, exact_blocker: sourceSyncReady ? null : "source_sync_contract_not_proven", required_evidence: "Same-run source-of-truth sync readback" },
    reconciliation: { ready: reconciliationReady, exact_blocker: reconciliationReady ? null : "reconciliation_contract_not_proven", required_evidence: "Same-run terminal reconciliation readback" },
    cleanup: { ready: cleanupReady, exact_blocker: cleanupReady ? null : "cleanup_contract_not_proven", required_evidence: "Task-owned process/session/lease cleanup receipt" }
  } as const;
  if (!providerReceiptReady || !sourceSyncReady || !reconciliationReady || !cleanupReady) {
    addBlocker(blockers, {
      code: "real_provider_receipt_source_sync_reconciliation_cleanup_not_proven",
      scope: "same_run_evidence",
      required_evidence: "Provider receipt, source sync, reconciliation, and cleanup in one Run"
    });
  }
  const homeBriefAvailable = input.brief_home_readback_available !== false;
  const deliveryConfigured = input.brief_delivery_configured === true;
  if (!deliveryConfigured) {
    addBlocker(blockers, {
      code: "brief_delivery_destination_and_morning_evening_time_not_decided",
      scope: "brief",
      required_evidence: "Owner-selected Brief destination and morning/evening schedule"
    });
  }
  const chat = {
    consultation_available: input.chat_consultation_available !== false,
    read_only_demo_available: input.chat_read_only_demo_available !== false,
    approval_preview_available: input.chat_approval_preview_available !== false,
    company_scoped_registration_ready: input.chat_registration_ready === true,
    exact_blocker: input.chat_registration_ready === true ? null : "chat_company_scoped_registration_not_ready"
  };
  if (!chat.company_scoped_registration_ready) {
    addBlocker(blockers, {
      code: chat.exact_blocker!,
      scope: "chat",
      required_evidence: "Chat consultation/demo/approval preview followed by company-scoped registration readback"
    });
  }
  const database = input.database ? { ...input.database, stable: stableDatabaseReadback(input.database) } : null;
  if (database?.stable === false) {
    addBlocker(blockers, {
      code: "local_sqlite_file_hash_changed_during_readback_requires_reconciliation",
      scope: "database",
      required_evidence: "Exact DB snapshot or Owner reconciliation of file identity/hash drift"
    });
  }
  const canonicalMatched = binding.status === "matched" && canonicalCompanyId !== null;
  const productionReady = canonicalMatched
    && serviceIdentity.configured
    && accountRefs.length > 0
    && accountRefs.every((row) => verifiedAccountRef(row))
    && input.provider_authority_fresh === true
    && input.browser_authority_fresh === true
    && graphReceiptBlocker === null
    && scheduleRows.every((row) => row.materialization_eligible)
    && providerReceiptReady
    && sourceSyncReady
    && reconciliationReady
    && cleanupReady
    && homeBriefAvailable
    && deliveryConfigured
    && chat.company_scoped_registration_ready
    && database?.stable !== false;
  return {
    schema: COMPANY_BINDING_READINESS_SCHEMA_V1,
    generated_at: new Date().toISOString(),
    status: productionReady ? "ready" : "blocked",
    production_ready: productionReady,
    canonical_company_id: canonicalMatched ? canonicalCompanyId : null,
    scope: {
      status: scopeStatus,
      trigger_company_id: triggerCompanyId,
      trigger_provenance: normalizedText(input.trigger_provenance) ?? "codex_trigger_readback",
      local_companies: localCompanies,
      canonical_authority: { selected: canonicalCompanyId !== null, fresh: authorityFresh, company_id: canonicalCompanyId }
    },
    service_identity: serviceIdentity,
    account_refs: { count: accountRefs.length, rows: accountRefs, values_exposed: false },
    schedules: scheduleRows,
    readiness: {
      ...evidenceRows,
      provider_authority_fresh: input.provider_authority_fresh === true,
      browser_authority_fresh: input.browser_authority_fresh === true,
      brief: {
        home_readback_available: homeBriefAvailable,
        delivery_configured: deliveryConfigured,
        external_notification_sent: false,
        exact_blocker: deliveryConfigured ? null : "brief_delivery_destination_and_morning_evening_time_not_decided"
      },
      chat
    },
    graph_receipt: {
      status: graphReceiptStatus,
      accepted_as_authority: false,
      replay_allowed: false,
      exact_blocker: graphReceiptBlocker
    },
    database,
    blockers,
    external_action_executed: false,
    mutation: {
      company_selected: false,
      trigger_rewired: false,
      schedule_materialized: false,
      run_created: false,
      provider_called: false,
      browser_started: false,
      notification_sent: false
    },
    next_action: productionReady
      ? "Begin the authorized one-company vertical Run and collect the same-run business receipt chain."
      : "Owner selects the protected AOS company/endpoint and clears the listed blockers; do not materialize schedules from this diagnostic."
  };
}

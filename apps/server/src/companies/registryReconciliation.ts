import { createHmac } from "node:crypto";
import { canonicalJson } from "../automations/idempotency.js";

export const COMPANY_REGISTRY_RECONCILIATION_SCHEMA = "aos.company_registry_reconciliation.v1" as const;

export type RegistryMatchClass = "matched" | "missing_company" | "duplicate" | "conflict" | "orphan";
export type RegistryChangeClass = "unchanged" | "changed" | "not_applicable";
export type RegistryActionability = "report_only" | "human_decision_required";

export type CompanyRegistryRecord = {
  recordId: string;
  companyId: unknown;
  identityKey: string;
  safeFields: Readonly<Record<string, unknown>>;
  expectedSafeFields?: Readonly<Record<string, unknown>>;
};

export type CompanyRegistryCompany = { companyId: unknown };

export type CompanyRegistryReconciliationInput = {
  records: readonly CompanyRegistryRecord[];
  knownCompanies: readonly CompanyRegistryCompany[];
  scopeCompanyIds?: readonly unknown[];
  /** A run-scoped key. It is used only to HMAC safe-field fingerprints and is never returned. */
  fingerprintKey: string;
};

export type CompanyRegistryReconciliationRecord = {
  record_id: string;
  company_id: string | null;
  identity_key: string;
  match_class: RegistryMatchClass;
  change_class: RegistryChangeClass;
  actionability: RegistryActionability;
  proposed_action: "none";
  reason_codes: string[];
  safe_fingerprint: string;
};

export type CompanyRegistryReconciliationReport = {
  schema: typeof COMPANY_REGISTRY_RECONCILIATION_SCHEMA;
  mode: "read_only_dry_run";
  fingerprint: { algorithm: "HMAC-SHA256"; key_scope: "run_scoped_not_returned" };
  summary: {
    total: number;
    report_only: number;
    human_decision_required: number;
    by_match_class: Record<RegistryMatchClass, number>;
    by_change_class: Record<RegistryChangeClass, number>;
  };
  records: CompanyRegistryReconciliationRecord[];
  mutation: { attempted: false; allowed: false };
};

export class CompanyRegistryReconciliationError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "CompanyRegistryReconciliationError";
  }
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const safeFieldAllowlist = new Set([
  "account_ref",
  "automation_id",
  "effect_class",
  "name",
  "provider",
  "runner_kind",
  "schedule_id",
  "status"
]);
const secretFieldPattern = /(?:access[_-]?token|api[_-]?key|authorization|cookie|env|header|password|query|refresh[_-]?token|secret|token)/iu;
const matchClassOrder: RegistryMatchClass[] = ["matched", "missing_company", "duplicate", "conflict", "orphan"];
const changeClassOrder: RegistryChangeClass[] = ["unchanged", "changed", "not_applicable"];

/**
 * Lossless canonicalization for a company identifier. Whitespace trimming,
 * case folding, Unicode normalization, and type coercion are deliberately
 * forbidden so two companies cannot collapse into one scope by accident.
 */
export function canonicalCompanyId(value: unknown, code = "company_id_invalid"): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || !identifierPattern.test(value)) {
    throw new CompanyRegistryReconciliationError(code);
  }
  return value;
}

function canonicalIdentifier(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || !identifierPattern.test(value)) {
    throw new CompanyRegistryReconciliationError(code);
  }
  return value;
}

function safeScalar(value: unknown): boolean {
  return value === null || typeof value === "string" || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

function canonicalSafeFields(value: Readonly<Record<string, unknown>>, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CompanyRegistryReconciliationError(code);
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (secretFieldPattern.test(key)) {
      throw new CompanyRegistryReconciliationError("secret_field_forbidden");
    }
    if (!safeFieldAllowlist.has(key)) {
      throw new CompanyRegistryReconciliationError("safe_field_not_allowed");
    }
    const fieldValue = value[key];
    if (Array.isArray(fieldValue)) {
      if (fieldValue.length > 100 || !fieldValue.every((item) => safeScalar(item))) {
        throw new CompanyRegistryReconciliationError("safe_field_value_invalid");
      }
      result[key] = [...fieldValue];
    } else if (safeScalar(fieldValue)) {
      if (typeof fieldValue === "string" && fieldValue.length > 1000) {
        throw new CompanyRegistryReconciliationError("safe_field_value_too_long");
      }
      result[key] = fieldValue;
    } else {
      throw new CompanyRegistryReconciliationError("safe_field_value_invalid");
    }
  }
  return result;
}

function hmacFingerprint(key: string, companyId: string | null, identityKey: string, safeFields: Record<string, unknown>): string {
  return createHmac("sha256", key)
    .update(canonicalJson({ company_id: companyId, identity_key: identityKey, safe_fields: safeFields }), "utf8")
    .digest("hex");
}

function emptyMatchCounts(): Record<RegistryMatchClass, number> {
  return { matched: 0, missing_company: 0, duplicate: 0, conflict: 0, orphan: 0 };
}

function emptyChangeCounts(): Record<RegistryChangeClass, number> {
  return { unchanged: 0, changed: 0, not_applicable: 0 };
}

/**
 * Reconcile an immutable registry snapshot without importing a database,
 * scheduler, provider, network, credential, or writer module. The function
 * returns proposals and classifications only; it never selects a canonical
 * duplicate/conflict and never mutates its input.
 */
export function reconcileCompanyRegistry(input: CompanyRegistryReconciliationInput): CompanyRegistryReconciliationReport {
  if (typeof input.fingerprintKey !== "string" || input.fingerprintKey.length < 16) {
    throw new CompanyRegistryReconciliationError("fingerprint_key_invalid");
  }
  if (!Array.isArray(input.records) || !Array.isArray(input.knownCompanies)) {
    throw new CompanyRegistryReconciliationError("registry_snapshot_invalid");
  }

  const knownCompanyIds = new Set<string>();
  for (const company of input.knownCompanies) {
    const companyId = canonicalCompanyId(company?.companyId, "known_company_id_invalid");
    if (knownCompanyIds.has(companyId)) throw new CompanyRegistryReconciliationError("known_company_duplicate");
    knownCompanyIds.add(companyId);
  }

  const scopeCompanyIds = input.scopeCompanyIds === undefined
    ? null
    : new Set(input.scopeCompanyIds.map((companyId) => canonicalCompanyId(companyId, "scope_company_id_invalid")));

  const recordIds = new Set<string>();
  const prepared = input.records.map((record) => {
    const recordId = canonicalIdentifier(record?.recordId, "registry_record_id_invalid");
    if (recordIds.has(recordId)) throw new CompanyRegistryReconciliationError("registry_record_id_duplicate");
    recordIds.add(recordId);
    const identityKey = canonicalIdentifier(record?.identityKey, "registry_identity_key_invalid");
    const safeFields = canonicalSafeFields(record?.safeFields, "registry_safe_fields_invalid");
    const expectedSafeFields = record?.expectedSafeFields === undefined
      ? undefined
      : canonicalSafeFields(record.expectedSafeFields, "registry_expected_safe_fields_invalid");
    let companyId: string | null = null;
    let companyIdReason = "";
    try {
      companyId = canonicalCompanyId(record?.companyId);
    } catch (error) {
      if (!(error instanceof CompanyRegistryReconciliationError)) throw error;
      companyIdReason = error.code;
    }
    return {
      recordId,
      identityKey,
      companyId,
      companyIdReason,
      safeFields,
      expectedSafeFields,
      safeFingerprint: hmacFingerprint(input.fingerprintKey, companyId, identityKey, safeFields)
    };
  });

  const groups = new Map<string, typeof prepared>();
  for (const row of prepared) {
    if (!row.companyId) continue;
    const key = `${row.companyId}\u0000${row.identityKey}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const records = prepared.map((row): CompanyRegistryReconciliationRecord => {
    let matchClass: RegistryMatchClass;
    const reasonCodes: string[] = [];
    if (!row.companyId) {
      matchClass = "missing_company";
      reasonCodes.push(row.companyIdReason || "company_id_invalid");
    } else if (scopeCompanyIds && !scopeCompanyIds.has(row.companyId)) {
      matchClass = "orphan";
      reasonCodes.push("scope_mismatch");
    } else if (!knownCompanyIds.has(row.companyId)) {
      matchClass = "orphan";
      reasonCodes.push("company_not_registered");
    } else {
      const group = groups.get(`${row.companyId}\u0000${row.identityKey}`) ?? [];
      if (group.length > 1) {
        const fingerprints = new Set(group.map((candidate) => candidate.safeFingerprint));
        if (fingerprints.size === 1) {
          matchClass = "duplicate";
          reasonCodes.push("duplicate_identity");
        } else {
          matchClass = "conflict";
          reasonCodes.push("conflicting_identity");
        }
      } else {
        matchClass = "matched";
        reasonCodes.push("exact_company_match");
      }
    }

    const changeClass: RegistryChangeClass = matchClass !== "matched" || row.expectedSafeFields === undefined
      ? "not_applicable"
      : canonicalJson(row.safeFields) === canonicalJson(row.expectedSafeFields) ? "unchanged" : "changed";
    reasonCodes.sort();
    return {
      record_id: row.recordId,
      company_id: row.companyId,
      identity_key: row.identityKey,
      match_class: matchClass,
      change_class: changeClass,
      actionability: matchClass === "matched" ? "report_only" : "human_decision_required",
      proposed_action: "none",
      reason_codes: reasonCodes,
      safe_fingerprint: row.safeFingerprint
    };
  }).sort((left, right) => left.record_id.localeCompare(right.record_id) || left.identity_key.localeCompare(right.identity_key));

  const byMatchClass = emptyMatchCounts();
  const byChangeClass = emptyChangeCounts();
  let reportOnly = 0;
  let humanDecisionRequired = 0;
  for (const record of records) {
    byMatchClass[record.match_class] += 1;
    byChangeClass[record.change_class] += 1;
    if (record.actionability === "report_only") reportOnly += 1;
    else humanDecisionRequired += 1;
  }

  return {
    schema: COMPANY_REGISTRY_RECONCILIATION_SCHEMA,
    mode: "read_only_dry_run",
    fingerprint: { algorithm: "HMAC-SHA256", key_scope: "run_scoped_not_returned" },
    summary: {
      total: records.length,
      report_only: reportOnly,
      human_decision_required: humanDecisionRequired,
      by_match_class: Object.fromEntries(matchClassOrder.map((key) => [key, byMatchClass[key]])) as Record<RegistryMatchClass, number>,
      by_change_class: Object.fromEntries(changeClassOrder.map((key) => [key, byChangeClass[key]])) as Record<RegistryChangeClass, number>
    },
    records,
    mutation: { attempted: false, allowed: false }
  };
}

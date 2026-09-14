import { createHash } from "node:crypto";
import { canonicalJson } from "../automations/idempotency.js";
import { canonicalCompanyId, type RegistryMatchClass } from "../companies/registryReconciliation.js";

export const LOCAL_BRIEF_BUNDLE_SCHEMA = "aos.local_brief_bundle.v1" as const;

export type LocalBriefType = "morning" | "evening";
export type LocalBriefCompanyStatus = "generated" | "empty";

export type BriefCompanySnapshot = {
  companyId: unknown;
  displayName: unknown;
};

/**
 * This input is deliberately a safe projection. It contains the human-readable
 * fields that a local Brief may show, not provider credentials, raw payloads,
 * cookies, tokens, or external receipts.
 */
export type BriefCandidateRecord = {
  recordId: unknown;
  companyId: unknown;
  matchClass: unknown;
  title: unknown;
  summary: unknown;
  nextAction?: unknown;
  scopeExcludedReason?: unknown;
};

export type CompanyBriefInput = {
  briefType: LocalBriefType;
  businessDate: unknown;
  timezone: unknown;
  templateVersion: unknown;
  companies: readonly BriefCompanySnapshot[];
  records: readonly BriefCandidateRecord[];
  scopeNote?: unknown;
};

export type LocalBriefItem = {
  record_id: string;
  title: string;
  summary: string;
  next_action: string | null;
};

export type LocalBriefCompany = {
  company_id: string;
  display_name: string;
  status: LocalBriefCompanyStatus;
  item_count: number;
  items: LocalBriefItem[];
};

export type LocalBriefExclusion = {
  record_id: string | null;
  reason: string;
};

export type LocalBriefBundle = {
  schema: typeof LOCAL_BRIEF_BUNDLE_SCHEMA;
  brief_type: LocalBriefType;
  business_date: string;
  timezone: string;
  input_fingerprint: string;
  template_version: string;
  status: "complete" | "partial";
  companies: LocalBriefCompany[];
  exclusions: LocalBriefExclusion[];
  scope_exclusions?: LocalBriefExclusion[];
  scope_note?: string;
  counts: {
    input_records: number;
    included_records: number;
    excluded_records: number;
    scope_excluded_records?: number;
    companies: number;
    generated_companies: number;
    empty_companies: number;
  };
  output_fingerprint: string;
  mutation: { attempted: false; allowed: false };
  delivery: { attempted: false; status: "not_attempted" };
};

export class CompanyBriefError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "CompanyBriefError";
  }
}

const registryMatchClasses = new Set<RegistryMatchClass>([
  "matched",
  "missing_company",
  "duplicate",
  "conflict",
  "orphan"
]);
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/u;
const templatePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const secretTextPattern = /(?:bearer\s+[A-Za-z0-9._-]{16,}|sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|-----BEGIN [^-]{1,80} PRIVATE KEY-----)/iu;

/**
 * Generate a deterministic, company-separated local Brief bundle.
 *
 * This function has no database, scheduler, provider, network, clock, or
 * delivery dependency. An exclusion makes the bundle partial, but it never
 * claims that a Run, provider action, source sync, reconciliation, or business
 * outcome completed.
 */
export function generateCompanyBriefs(input: CompanyBriefInput): LocalBriefBundle {
  const normalized = normalizeInput(input);
  const companyMap = new Map<string, { company_id: string; display_name: string }>();
  for (const company of normalized.companies) {
    if (companyMap.has(company.company_id)) throw new CompanyBriefError("company_id_duplicate");
    companyMap.set(company.company_id, company);
  }

  const records = normalized.records;
  const recordIds = new Set<string>();
  const itemsByCompany = new Map<string, LocalBriefItem[]>();
  const exclusions: LocalBriefExclusion[] = [];
  const scopeExclusions: LocalBriefExclusion[] = [];
  const fingerprintRecords: Array<Record<string, unknown>> = [];

  for (const record of records) {
    const recordId = canonicalRecordId(record.recordId);
    if (recordIds.has(recordId)) throw new CompanyBriefError("record_id_duplicate");
    recordIds.add(recordId);

    const matchClass = record.matchClass;
    if (!isRegistryMatchClass(matchClass)) {
      throw new CompanyBriefError("match_class_invalid");
    }
    if (matchClass !== "matched") {
      exclusions.push({ record_id: recordId, reason: `registry_${matchClass}` });
      fingerprintRecords.push({ record_id: recordId, match_class: matchClass, company_id: null });
      continue;
    }

    let companyId: string;
    try {
      companyId = canonicalCompanyId(record.companyId, "matched_company_id_invalid");
    } catch (error) {
      if (error instanceof Error && "code" in error && typeof error.code === "string") {
        throw new CompanyBriefError(error.code);
      }
      throw error;
    }
    const company = companyMap.get(companyId);
    if (!company) {
      exclusions.push({ record_id: recordId, reason: "company_not_registered" });
      fingerprintRecords.push({ record_id: recordId, match_class: matchClass, company_id: companyId });
      continue;
    }

    // A user-selected display scope is not a registry failure or a completed
    // business action. Keep it separate from technical exclusions and delivery.
    const scopeReason = optionalBriefText(record.scopeExcludedReason, "scope_exclusion_invalid", 240);
    if (scopeReason) {
      scopeExclusions.push({ record_id: recordId, reason: scopeReason });
      fingerprintRecords.push({ record_id: recordId, match_class: matchClass, company_id: companyId, scope_excluded_reason: scopeReason });
      continue;
    }
    const item = {
      record_id: recordId,
      title: safeBriefText(record.title, "brief_title_invalid", 240),
      summary: safeBriefText(record.summary, "brief_summary_invalid", 4000),
      next_action: optionalBriefText(record.nextAction, "brief_next_action_invalid", 1000)
    } satisfies LocalBriefItem;
    const companyItems = itemsByCompany.get(companyId) ?? [];
    companyItems.push(item);
    itemsByCompany.set(companyId, companyItems);
    fingerprintRecords.push({
      record_id: recordId,
      match_class: matchClass,
      company_id: companyId,
      title: item.title,
      summary: item.summary,
      next_action: item.next_action
    });
  }

  const normalizedFingerprintInput = {
    ...(normalized.scope_note ? { scope_note: normalized.scope_note } : {}),
    brief_type: normalized.brief_type,
    business_date: normalized.business_date,
    timezone: normalized.timezone,
    template_version: normalized.template_version,
    companies: normalized.companies,
    records: fingerprintRecords.sort((left, right) => compareText(String(left.record_id), String(right.record_id)))
  };
  const inputFingerprint = sha256(canonicalJson(normalizedFingerprintInput));
  const companies = normalized.companies.map((company) => {
    const items = (itemsByCompany.get(company.company_id) ?? [])
      .sort((left, right) => compareText(left.record_id, right.record_id));
    return {
      company_id: company.company_id,
      display_name: company.display_name,
      status: items.length > 0 ? "generated" : "empty",
      item_count: items.length,
      items
    } satisfies LocalBriefCompany;
  });
  exclusions.sort((left, right) => compareText(left.record_id ?? "", right.record_id ?? "") || compareText(left.reason, right.reason));
  scopeExclusions.sort((left, right) => compareText(left.record_id ?? "", right.record_id ?? ""));

  const withoutOutputFingerprint = {
    schema: LOCAL_BRIEF_BUNDLE_SCHEMA,
    brief_type: normalized.brief_type,
    business_date: normalized.business_date,
    timezone: normalized.timezone,
    input_fingerprint: inputFingerprint,
    template_version: normalized.template_version,
    status: exclusions.length > 0 ? "partial" : "complete",
    companies,
    exclusions,
    ...(scopeExclusions.length ? { scope_exclusions: scopeExclusions } : {}),
    ...(normalized.scope_note ? { scope_note: normalized.scope_note } : {}),
    counts: {
      input_records: records.length,
      included_records: records.length - exclusions.length - scopeExclusions.length,
      excluded_records: exclusions.length,
      ...(scopeExclusions.length ? { scope_excluded_records: scopeExclusions.length } : {}),
      companies: companies.length,
      generated_companies: companies.filter((company) => company.status === "generated").length,
      empty_companies: companies.filter((company) => company.status === "empty").length
    },
    mutation: { attempted: false, allowed: false },
    delivery: { attempted: false, status: "not_attempted" }
  } as const;

  return {
    ...withoutOutputFingerprint,
    output_fingerprint: sha256(canonicalJson(withoutOutputFingerprint))
  };
}

function normalizeInput(input: CompanyBriefInput) {
  if (!input || !Array.isArray(input.companies) || !Array.isArray(input.records)) {
    throw new CompanyBriefError("brief_input_invalid");
  }
  if (input.briefType !== "morning" && input.briefType !== "evening") {
    throw new CompanyBriefError("brief_type_invalid");
  }
  const businessDate = canonicalDate(input.businessDate);
  const timezone = canonicalTimezone(input.timezone);
  const templateVersion = canonicalTemplateVersion(input.templateVersion);
  const companies = input.companies.map((company) => ({
    company_id: canonicalCompanyId(company?.companyId, "company_id_invalid"),
    display_name: safeBriefText(company?.displayName, "company_display_name_invalid", 200)
  })).sort((left, right) => compareText(left.company_id, right.company_id));
  return {
    brief_type: input.briefType,
    business_date: businessDate,
    timezone,
    template_version: templateVersion,
    companies,
    scope_note: optionalBriefText(input.scopeNote, "scope_note_invalid", 1000),
    records: input.records
  };
}

function canonicalRecordId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || !identifierPattern.test(value)) {
    throw new CompanyBriefError("record_id_invalid");
  }
  return value;
}

function canonicalDate(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim()) throw new CompanyBriefError("business_date_invalid");
  const match = datePattern.exec(value);
  if (!match) throw new CompanyBriefError("business_date_invalid");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new CompanyBriefError("business_date_invalid");
  }
  return value;
}

function canonicalTimezone(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 100 || value !== value.trim()) {
    throw new CompanyBriefError("timezone_invalid");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
  } catch {
    throw new CompanyBriefError("timezone_invalid");
  }
  return value;
}

function canonicalTemplateVersion(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || !templatePattern.test(value)) {
    throw new CompanyBriefError("template_version_invalid");
  }
  return value;
}

function safeBriefText(value: unknown, code: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || value.length > maxLength) {
    throw new CompanyBriefError(code);
  }
  if (secretTextPattern.test(value)) throw new CompanyBriefError("brief_sensitive_text_forbidden");
  return value;
}

function optionalBriefText(value: unknown, code: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  return safeBriefText(value, code, maxLength);
}

function isRegistryMatchClass(value: unknown): value is RegistryMatchClass {
  return typeof value === "string" && registryMatchClasses.has(value as RegistryMatchClass);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

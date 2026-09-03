import { createHash } from "node:crypto";
import { execSql, execSqlAsync, insert, insertAsync, markAsyncSchemaReady, nowIso, querySql, querySqlAsync, sqlValue } from "../db/client.js";

export const JOB_APPLICATION_MIN_SALARY_JPY = 5_000_000;
export const JOB_APPLICATION_DAILY_TARGET = 20;
export const JOB_APPLICATION_CUMULATIVE_TARGET = 1_000;
export const JOB_APPLICATION_DUPLICATE_WINDOW_DAYS = 30;
export const JOB_APPLICATION_SHEET_MIRROR_SCHEMA = "aos.job_application_sheet_mirror.v1" as const;
export const JOB_APPLICATION_SHEET_MIRROR_SYNC_SCHEMA = "aos.job_application_sheet_mirror_sync.v1" as const;

const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,399}$/u;
const SAFE_URL = /^https?:\/\/[^\s@/]+(?:\/[^\s]*)?$/iu;

export type CandidateLanguage = "ja" | "en";
export type CandidateWorkLocation = "japan" | "remote_from_japan" | "hybrid_japan" | "overseas";
export type CandidateWorkAuthorization = "japan_visa" | "remote_from_japan_allowed" | "unknown" | "not_authorized";
export type CandidateRemoteMode = "remote" | "hybrid" | "onsite" | "unknown";
export type CandidateSalaryPeriod = "annual" | "monthly" | "weekly" | "hourly" | "unknown";
export type CandidateStatus = "eligible" | "blocked" | "duplicate_excluded" | "admitted" | "submitted_confirmed" | "reconciliation_required" | "rejected" | "expired";

export class JobApplicationOperationsError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "JobApplicationOperationsError";
  }
}

export type CandidateSupplyInput = {
  candidateKey?: string | null;
  sourceSnapshotId: string;
  sourceSnapshotExpiresAt: string;
  supplyRunId: string;
  jobUrl: string | null;
  jobId: string | null;
  applicationUrl: string | null;
  companyName: string;
  role: string;
  language: CandidateLanguage;
  salaryOriginalMin: number | null;
  salaryOriginalMax: number | null;
  salaryCurrency: string;
  salaryPeriod: CandidateSalaryPeriod;
  fxToJpy: number | null;
  salarySourceUrl: string | null;
  fxSourceUrl: string | null;
  salarySourceTime: string | null;
  workLocation: CandidateWorkLocation;
  workAuthorization: CandidateWorkAuthorization;
  remoteMode: CandidateRemoteMode;
}

export type CandidateSupplyRecord = CandidateSupplyInput & {
  id: string;
  companyId: string;
  candidateKey: string;
  resumeLocale: "ja-JP" | "en-US";
  salaryJpy: number | null;
  dedupeKey: string;
  status: CandidateStatus;
  blocker: string | null;
  nextAction: string;
  targetDigest: string;
  createdAt: string;
  updatedAt: string;
};

export type CandidateClassification = {
  resumeLocale: "ja-JP" | "en-US";
  salaryJpy: number | null;
  dedupeKey: string;
  status: Extract<CandidateStatus, "eligible" | "blocked" | "duplicate_excluded">;
  blockers: string[];
  nextAction: string;
};

export type DigestInput = {
  candidates: readonly Pick<CandidateSupplyRecord, "status" | "blocker" | "salaryJpy" | "updatedAt">[];
  admissions: readonly { status?: string | null; updated_at?: string | null; created_at?: string | null }[];
  sheetMirrors?: readonly { syncStatus: string; blocker: string | null }[];
  delayedQueueCount?: number | null;
  historicalSuccessCount?: number | null;
  dateKey?: string;
};

export type JobApplicationDigest = {
  schema: "aos.job_application_digest.v1";
  date_jst: string;
  target: number;
  cumulative_target: number;
  cumulative_success: number | null;
  candidate_count: number;
  eligible_candidate_count: number;
  success_count: number;
  stopped_count: number;
  awaiting_reconciliation_count: number;
  duplicate_excluded_count: number;
  salary_evidence_missing_count: number;
  salary_annual_threshold_unproven_count: number;
  salary_below_threshold_count: number;
  sheet_sync_failed_count: number;
  delayed_queue_count: number | null;
  blockers: Record<string, number>;
  next_action: string;
  external_action_executed: false;
};

export type SheetMirrorRow = {
  date_jst: string;
  candidate_key: string;
  company: string;
  role: string;
  job_url: string | null;
  language: CandidateLanguage;
  resume_ref: string;
  salary_original: string | null;
  salary_period: CandidateSalaryPeriod;
  salary_jpy: number | null;
  salary_source_time: string | null;
  status: CandidateStatus;
  run_id: string | null;
  receipt_ref: string | null;
  blocker: string | null;
  next_action: string;
  updated_at: string;
};

/**
 * Internal mirror payload. The native AOS候補 sheet remains a stable 20-column
 * contract; these audit fields stay in the local row_json evidence so a mirror
 * cannot lose its current target or company scope between readbacks.
 */
export function buildSheetMirrorPayload(companyId: string, candidate: CandidateSupplyRecord, row: SheetMirrorRow, sync?: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: JOB_APPLICATION_SHEET_MIRROR_SCHEMA,
    ...row,
    target_digest: candidate.targetDigest,
    owner_scope: companyId,
    ...(sync ? { sync } : {})
  };
}

export type SheetMirrorReadbackInput = {
  schema: typeof JOB_APPLICATION_SHEET_MIRROR_SYNC_SCHEMA;
  spreadsheetId: string;
  sheetId: string;
  sheetName: string;
  range: string;
  readbackAt: string;
  rows: readonly { rowNumber: number; values: readonly unknown[] }[];
};

export type SheetMirrorPopulationAudit = {
  schema: "aos.job_application_sheet_population_audit.v1";
  company_id: string;
  source_count: number;
  sheet_row_count: number;
  sheet_data_row_count: number;
  blank_row_count: number;
  malformed_row_count: number;
  matching_candidate_count: number;
  source_only_candidate_keys: readonly string[];
  sheet_only_candidate_keys: readonly string[];
  duplicate_source_candidate_keys: readonly string[];
  duplicate_sheet_candidate_keys: readonly string[];
  population_exact: boolean;
  external_action_executed: false;
};

/**
 * Compare candidate population without asserting full row equality or writing
 * anything. This deliberately remains separate from the strict 20-column
 * sync planner so population drift can be diagnosed before any repair.
 */
export function auditSheetMirrorPopulation(
  companyId: string,
  candidates: readonly Pick<CandidateSupplyRecord, "candidateKey">[],
  input: SheetMirrorReadbackInput
): SheetMirrorPopulationAudit {
  const countKeys = (keys: readonly string[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  };
  const sourceKeys = candidates.map((candidate) => candidate.candidateKey);
  const sourceCounts = countKeys(sourceKeys);
  const sheetKeys: string[] = [];
  let blankRowCount = 0;
  let malformedRowCount = 0;
  for (const row of input.rows) {
    if (row.values.length !== 20) malformedRowCount += 1;
    const rawKey = row.values[0];
    const key = typeof rawKey === "string" || typeof rawKey === "number" ? String(rawKey).trim() : "";
    if (!key) {
      blankRowCount += 1;
      continue;
    }
    sheetKeys.push(key);
  }
  const sheetCounts = countKeys(sheetKeys);
  const sourceKeySet = new Set(sourceKeys);
  const sheetKeySet = new Set(sheetKeys);
  const sourceOnly = [...sourceKeySet].filter((key) => !sheetKeySet.has(key)).sort();
  const sheetOnly = [...sheetKeySet].filter((key) => !sourceKeySet.has(key)).sort();
  const duplicateSource = [...sourceCounts].filter(([, count]) => count > 1).map(([key]) => key).sort();
  const duplicateSheet = [...sheetCounts].filter(([, count]) => count > 1).map(([key]) => key).sort();
  return {
    schema: "aos.job_application_sheet_population_audit.v1",
    company_id: companyId,
    source_count: sourceKeys.length,
    sheet_row_count: input.rows.length,
    sheet_data_row_count: sheetKeys.length,
    blank_row_count: blankRowCount,
    malformed_row_count: malformedRowCount,
    matching_candidate_count: [...sourceKeySet].filter((key) => sheetKeySet.has(key)).length,
    source_only_candidate_keys: sourceOnly,
    sheet_only_candidate_keys: sheetOnly,
    duplicate_source_candidate_keys: duplicateSource,
    duplicate_sheet_candidate_keys: duplicateSheet,
    population_exact: sourceOnly.length === 0 && sheetOnly.length === 0 && duplicateSource.length === 0 && duplicateSheet.length === 0 && blankRowCount === 0 && malformedRowCount === 0,
    external_action_executed: false
  };
}

export type SheetMirrorSyncPlan = {
  rowsSynced: number;
  readbackFingerprint: string;
  resourceSteps: readonly { sql: string; expectChanges?: number }[];
};

let candidateSchemaEnsured = false;
let candidateSchemaEnsurePromise: Promise<void> | undefined;

/** The production schema may be provisioned out-of-band; keep this lazy and
 * limited to the candidate tables so server health does not depend on a
 * remote migration during process startup. It never touches schedules. */
export async function ensureCandidateSupplySchemaAsync(): Promise<void> {
  if (candidateSchemaEnsured) return;
  if (candidateSchemaEnsurePromise) return candidateSchemaEnsurePromise;
  candidateSchemaEnsurePromise = (async () => {
    try {
      await execSqlAsync(`
      CREATE TABLE IF NOT EXISTS job_application_candidate_supply (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        candidate_key TEXT NOT NULL,
        source_snapshot_id TEXT NOT NULL,
        source_snapshot_expires_at TEXT NOT NULL,
        supply_run_id TEXT NOT NULL,
        job_url TEXT,
        job_id TEXT,
        application_url TEXT,
        company_name TEXT NOT NULL,
        role TEXT NOT NULL,
        language TEXT NOT NULL,
        resume_locale TEXT NOT NULL,
        salary_original_min REAL,
        salary_original_max REAL,
        salary_currency TEXT NOT NULL,
        salary_period TEXT NOT NULL DEFAULT 'annual',
        fx_to_jpy REAL,
        salary_jpy REAL,
        salary_source_url TEXT,
        fx_source_url TEXT,
        salary_source_time TEXT,
        work_location TEXT NOT NULL,
        work_authorization TEXT NOT NULL,
        remote_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        blocker TEXT,
        next_action TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        target_digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(company_id, candidate_key)
      );
      CREATE INDEX IF NOT EXISTS job_application_candidate_supply_company_idx ON job_application_candidate_supply(company_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS job_application_candidate_supply_dedupe_idx ON job_application_candidate_supply(company_id, dedupe_key, created_at DESC);
      CREATE TABLE IF NOT EXISTS job_application_sheet_mirrors (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        candidate_key TEXT NOT NULL,
        date_jst TEXT NOT NULL,
        row_json TEXT NOT NULL,
        row_fingerprint TEXT NOT NULL,
        sync_status TEXT NOT NULL,
        blocker TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(company_id, candidate_key)
      );
      CREATE INDEX IF NOT EXISTS job_application_sheet_mirrors_company_idx ON job_application_sheet_mirrors(company_id, sync_status, updated_at DESC);
      `);
      // execSqlAsync deliberately invalidates the process-local PostgreSQL
      // readiness marker after DDL. This helper owns a bounded lazy schema
      // ensure, so restore readiness before the next idempotent migration step
      // instead of making the following ALTER fail with
      // postgres_async_schema_not_ready.
      markAsyncSchemaReady();
      let salaryPeriodReady = false;
      try {
        await execSqlAsync("ALTER TABLE job_application_candidate_supply ADD COLUMN salary_period TEXT NOT NULL DEFAULT 'annual'");
        salaryPeriodReady = true;
      } catch (error) {
        const message = String(error).toLowerCase();
        if (!message.includes("duplicate column") && !message.includes("already exists")) throw error;
        salaryPeriodReady = true;
      }
      if (salaryPeriodReady) markAsyncSchemaReady();
      await execSqlAsync(`
        UPDATE job_application_candidate_supply
        SET salary_period='hourly', salary_jpy=NULL, status='blocked',
            blocker='annual_salary_threshold_not_proven_from_hourly_contract_range',
            next_action='時給を年収へ換算する契約時間根拠がないため、年収根拠を確認してから進む'
        WHERE salary_period='annual'
          AND (lower(role) LIKE '%/hr%' OR lower(role) LIKE '%per hour%' OR lower(role) LIKE '%hourly%')
      `);
      markAsyncSchemaReady();
      candidateSchemaEnsured = true;
    } catch {
      throw new JobApplicationOperationsError("candidate_supply_schema_unavailable");
    }
  })().finally(() => {
    candidateSchemaEnsurePromise = undefined;
  });
  return candidateSchemaEnsurePromise;
}

export function parseCandidateSupplyInput(value: unknown, now = nowIso()): CandidateSupplyInput {
  const body = objectValue(value, "candidate_supply_body_required");
  const allowed = new Set([
    "candidate_key", "source_snapshot_id", "source_snapshot_expires_at", "supply_run_id", "job_url", "job_id", "application_url",
    "company_name", "role", "language", "salary_original_min", "salary_original_max", "salary_currency", "salary_period", "fx_to_jpy",
    "salary_source_url", "fx_source_url", "salary_source_time", "work_location", "work_authorization", "remote_mode"
  ]);
  for (const key of Object.keys(body)) if (!allowed.has(key)) throw new JobApplicationOperationsError("candidate_supply_unknown_field");
  const jobUrl = nullableUrl(body.job_url, "candidate_supply_job_url_invalid");
  const jobId = nullableRef(body.job_id, "candidate_supply_job_id_invalid");
  if (!jobUrl && !jobId) throw new JobApplicationOperationsError("candidate_supply_job_url_or_id_required");
  const sourceSnapshotId = requiredRef(body.source_snapshot_id, "candidate_supply_source_snapshot_id_required");
  const sourceSnapshotExpiresAt = futureIso(body.source_snapshot_expires_at, now, "candidate_supply_source_snapshot_expired");
  const supplyRunId = requiredRef(body.supply_run_id, "candidate_supply_run_id_required");
  const companyName = requiredText(body.company_name, "candidate_supply_company_required", 240);
  const role = requiredText(body.role, "candidate_supply_role_required", 240);
  const language = body.language === "ja" || body.language === "en" ? body.language : (() => { throw new JobApplicationOperationsError("candidate_supply_language_invalid"); })();
  const salaryOriginalMin = nullableNumber(body.salary_original_min, "candidate_supply_salary_min_invalid");
  const salaryOriginalMax = nullableNumber(body.salary_original_max, "candidate_supply_salary_max_invalid");
  if (salaryOriginalMin !== null && salaryOriginalMin <= 0) throw new JobApplicationOperationsError("candidate_supply_salary_min_invalid");
  if (salaryOriginalMax !== null && salaryOriginalMax <= 0) throw new JobApplicationOperationsError("candidate_supply_salary_max_invalid");
  if (salaryOriginalMin !== null && salaryOriginalMax !== null && salaryOriginalMax < salaryOriginalMin) throw new JobApplicationOperationsError("candidate_supply_salary_range_invalid");
  const salaryCurrency = requiredText(body.salary_currency, "candidate_supply_salary_currency_required", 12).toUpperCase();
  const salaryPeriod = body.salary_period === undefined || body.salary_period === null || body.salary_period === ""
    ? "annual"
    : enumValue(body.salary_period, ["annual", "monthly", "weekly", "hourly", "unknown"], "candidate_supply_salary_period_invalid");
  const fxToJpy = nullableNumber(body.fx_to_jpy, "candidate_supply_fx_invalid");
  if (fxToJpy !== null && fxToJpy <= 0) throw new JobApplicationOperationsError("candidate_supply_fx_invalid");
  const salarySourceUrl = nullableUrl(body.salary_source_url, "candidate_supply_salary_source_url_invalid");
  const fxSourceUrl = nullableUrl(body.fx_source_url, "candidate_supply_fx_source_url_invalid");
  const salarySourceTime = nullableText(body.salary_source_time, 80);
  const workLocation = enumValue(body.work_location, ["japan", "remote_from_japan", "hybrid_japan", "overseas"], "candidate_supply_work_location_invalid");
  const workAuthorization = enumValue(body.work_authorization, ["japan_visa", "remote_from_japan_allowed", "unknown", "not_authorized"], "candidate_supply_work_authorization_invalid");
  const remoteMode = enumValue(body.remote_mode, ["remote", "hybrid", "onsite", "unknown"], "candidate_supply_remote_mode_invalid");
  const applicationUrl = nullableUrl(body.application_url ?? jobUrl, "candidate_supply_application_url_invalid");
  const candidateKey = body.candidate_key === undefined || body.candidate_key === null ? null : requiredRef(body.candidate_key, "candidate_supply_candidate_key_invalid");
  return {
    candidateKey,
    sourceSnapshotId,
    sourceSnapshotExpiresAt,
    supplyRunId,
    jobUrl,
    jobId,
    applicationUrl,
    companyName,
    role,
    language,
    salaryOriginalMin,
    salaryOriginalMax,
    salaryCurrency,
    salaryPeriod,
    fxToJpy,
    salarySourceUrl,
    fxSourceUrl,
    salarySourceTime,
    workLocation,
    workAuthorization,
    remoteMode
  };
}

export function classifyCandidate(input: CandidateSupplyInput, existing: readonly Pick<CandidateSupplyRecord, "companyName" | "role" | "dedupeKey" | "status" | "createdAt" | "jobUrl" | "jobId">[] = [], now = new Date()): CandidateClassification {
  const resumeLocale = input.language === "ja" ? "ja-JP" : "en-US";
  const dedupeKey = createDedupeKey(input.companyName, input.role);
  const blockers: string[] = [];
  const salaryJpy = calculateSalaryJpy(input);
  if (input.salaryPeriod === "hourly") {
    blockers.push("annual_salary_threshold_not_proven_from_hourly_contract_range");
  } else if (input.salaryPeriod === "unknown") {
    blockers.push("salary_period_unverified");
  } else if (input.salaryOriginalMin === null || !input.salarySourceUrl || !input.salarySourceTime || (input.salaryCurrency !== "JPY" && (!input.fxToJpy || !input.fxSourceUrl))) {
    blockers.push("salary_evidence_missing");
  } else if (salaryJpy === null || salaryJpy < JOB_APPLICATION_MIN_SALARY_JPY) {
    blockers.push("salary_below_threshold");
  }
  if (!(["japan_visa", "remote_from_japan_allowed"] as string[]).includes(input.workAuthorization)) blockers.push("japan_work_authorization_unconfirmed");
  if (input.workLocation === "overseas" && input.workAuthorization !== "remote_from_japan_allowed") blockers.push("overseas_work_authorization_unconfirmed");
  const duplicateCount = existing.filter((row) => {
    const active = !["rejected", "expired"].includes(row.status);
    const recent = Date.parse(row.createdAt) >= now.getTime() - JOB_APPLICATION_DUPLICATE_WINDOW_DAYS * 86_400_000;
    const sameTarget = row.dedupeKey === dedupeKey || (row.jobUrl && input.jobUrl && row.jobUrl === input.jobUrl) || (row.jobId && input.jobId && row.jobId === input.jobId);
    return active && recent && sameTarget;
  }).length;
  if (duplicateCount >= 2) blockers.push("duplicate_company_role_30_day_window");
  const status = blockers.includes("duplicate_company_role_30_day_window") ? "duplicate_excluded" : blockers.length ? "blocked" : "eligible";
  return {
    resumeLocale,
    salaryJpy,
    dedupeKey,
    status,
    blockers,
    nextAction: blockers.length ? blockers.includes("duplicate_company_role_30_day_window") ? "同一会社・職種の30日上限に達したため新規応募を作らず、別候補へ進む" : "不足している給与根拠・就労条件・対象情報を確認してからtarget admissionへ進む" : "fresh target/account/authorityを束縛し、応募前確認へ進む"
  };
}

export function buildCandidateRecord(companyId: string, input: CandidateSupplyInput, classification: CandidateClassification, now = nowIso()): CandidateSupplyRecord {
  const candidateKey = input.candidateKey ?? `job_candidate_${sha256(JSON.stringify({ company: input.companyName, role: input.role, url: input.jobUrl, id: input.jobId })).slice(0, 32)}`;
  const targetDigest = sha256(JSON.stringify({ companyId, candidateKey, url: input.jobUrl, jobId: input.jobId, source: input.sourceSnapshotId, run: input.supplyRunId }));
  return {
    ...input,
    id: `job_candidate_supply_${sha256(`${companyId}:${candidateKey}`).slice(0, 32)}`,
    companyId,
    candidateKey,
    resumeLocale: classification.resumeLocale,
    salaryJpy: classification.salaryJpy,
    dedupeKey: classification.dedupeKey,
    status: classification.status,
    blocker: classification.blockers.length ? classification.blockers.join(",") : null,
    nextAction: classification.nextAction,
    targetDigest,
    createdAt: now,
    updatedAt: now
  };
}

export function listCandidateSupply(companyId: string, limit = 100): CandidateSupplyRecord[] {
  const rows = querySql<Record<string, unknown>>(`
    SELECT * FROM job_application_candidate_supply
    WHERE company_id=${sqlValue(companyId)}
    ORDER BY updated_at DESC, id DESC
    LIMIT ${Math.max(1, Math.min(500, Math.floor(limit)))}
  `);
  return rows.map(candidateFromRow);
}

export async function listCandidateSupplyAsync(companyId: string, limit = 100): Promise<CandidateSupplyRecord[]> {
  const rows = await querySqlAsync<Record<string, unknown>>(`
    SELECT * FROM job_application_candidate_supply
    WHERE company_id=${sqlValue(companyId)}
    ORDER BY updated_at DESC, id DESC
    LIMIT ${Math.max(1, Math.min(500, Math.floor(limit)))}
  `);
  return rows.map(candidateFromRow);
}

export function saveCandidateSupply(record: CandidateSupplyRecord): { replayed: boolean; candidate: CandidateSupplyRecord } {
  const existing = querySql<Record<string, unknown>>(`SELECT * FROM job_application_candidate_supply WHERE company_id=${sqlValue(record.companyId)} AND candidate_key=${sqlValue(record.candidateKey)} LIMIT 1`)[0];
  if (existing) {
    const current = candidateFromRow(existing);
    if (current.targetDigest !== record.targetDigest) throw new JobApplicationOperationsError("candidate_supply_existing_key_binding_mismatch");
    return { replayed: true, candidate: current };
  }
  insert("job_application_candidate_supply", candidateToRow(record));
  return { replayed: false, candidate: record };
}

export async function saveCandidateSupplyAsync(record: CandidateSupplyRecord): Promise<{ replayed: boolean; candidate: CandidateSupplyRecord }> {
  const existing = (await querySqlAsync<Record<string, unknown>>(`SELECT * FROM job_application_candidate_supply WHERE company_id=${sqlValue(record.companyId)} AND candidate_key=${sqlValue(record.candidateKey)} LIMIT 1`))[0];
  if (existing) {
    const current = candidateFromRow(existing);
    if (current.targetDigest !== record.targetDigest) throw new JobApplicationOperationsError("candidate_supply_existing_key_binding_mismatch");
    return { replayed: true, candidate: current };
  }
  await insertAsync("job_application_candidate_supply", candidateToRow(record));
  return { replayed: false, candidate: record };
}

export function prepareSheetMirror(companyId: string, candidate: CandidateSupplyRecord, admission?: { status?: string | null; run_id?: string | null; receipt_ref?: string | null }): SheetMirrorRow {
  const row: SheetMirrorRow = {
    date_jst: jstDateKey(candidate.updatedAt),
    candidate_key: candidate.candidateKey,
    company: candidate.companyName,
    role: candidate.role,
    job_url: candidate.jobUrl,
    language: candidate.language,
    resume_ref: `profile2:${candidate.resumeLocale}`,
    salary_original: candidate.salaryOriginalMin === null ? null : `${candidate.salaryOriginalMin}${candidate.salaryOriginalMax !== null ? `-${candidate.salaryOriginalMax}` : ""} ${candidate.salaryCurrency}`,
    salary_period: candidate.salaryPeriod,
    salary_jpy: candidate.salaryJpy,
    salary_source_time: candidate.salarySourceTime,
    status: (admission?.status === "reconciled" ? "submitted_confirmed" : admission?.status === "submitted" ? "reconciliation_required" : candidate.status) as CandidateStatus,
    run_id: admission?.run_id ?? null,
    receipt_ref: admission?.receipt_ref ?? null,
    blocker: candidate.blocker,
    next_action: candidate.nextAction,
    updated_at: candidate.updatedAt
  };
  return row;
}

export function upsertSheetMirror(companyId: string, candidate: CandidateSupplyRecord, admission?: { status?: string | null; run_id?: string | null; receipt_ref?: string | null }): { row: SheetMirrorRow; syncStatus: "prepared" | "synced"; blocker: "sheets_connector_unverified" | null } {
  const row = prepareSheetMirror(companyId, candidate, admission);
  const id = `job_sheet_mirror_${sha256(`${companyId}:${candidate.candidateKey}`).slice(0, 32)}`;
  const now = nowIso();
  const existing = querySql<{ id: string; sync_status: string; blocker: string | null }>(`SELECT id, sync_status, blocker FROM job_application_sheet_mirrors WHERE id=${sqlValue(id)} LIMIT 1`)[0];
  if (existing?.sync_status === "synced") return { row, syncStatus: "synced", blocker: null };
  const values = { id, company_id: companyId, candidate_key: candidate.candidateKey, date_jst: row.date_jst, row_json: JSON.stringify(buildSheetMirrorPayload(companyId, candidate, row)), row_fingerprint: sha256(JSON.stringify(row)), sync_status: "prepared", blocker: "sheets_connector_unverified", updated_at: now };
  if (existing) {
    const assignments = Object.entries(values).filter(([key]) => key !== "id").map(([key, value]) => `${key}=${sqlValue(value)}`).join(", ");
    execSql(`UPDATE job_application_sheet_mirrors SET ${assignments} WHERE id=${sqlValue(id)}`);
  } else {
    insert("job_application_sheet_mirrors", values);
  }
  return { row, syncStatus: "prepared", blocker: "sheets_connector_unverified" };
}

export async function upsertSheetMirrorAsync(companyId: string, candidate: CandidateSupplyRecord, admission?: { status?: string | null; run_id?: string | null; receipt_ref?: string | null }): Promise<{ row: SheetMirrorRow; syncStatus: "prepared" | "synced"; blocker: "sheets_connector_unverified" | null }> {
  const row = prepareSheetMirror(companyId, candidate, admission);
  const id = `job_sheet_mirror_${sha256(`${companyId}:${candidate.candidateKey}`).slice(0, 32)}`;
  const now = nowIso();
  const existing = (await querySqlAsync<{ id: string; sync_status: string; blocker: string | null }>(`SELECT id, sync_status, blocker FROM job_application_sheet_mirrors WHERE id=${sqlValue(id)} LIMIT 1`))[0];
  if (existing?.sync_status === "synced") return { row, syncStatus: "synced", blocker: null };
  const values = { id, company_id: companyId, candidate_key: candidate.candidateKey, date_jst: row.date_jst, row_json: JSON.stringify(buildSheetMirrorPayload(companyId, candidate, row)), row_fingerprint: sha256(JSON.stringify(row)), sync_status: "prepared", blocker: "sheets_connector_unverified", updated_at: now };
  if (existing) {
    const assignments = Object.entries(values).filter(([key]) => key !== "id").map(([key, value]) => `${key}=${sqlValue(value)}`).join(", ");
    await execSqlAsync(`UPDATE job_application_sheet_mirrors SET ${assignments} WHERE id=${sqlValue(id)}`);
  } else {
    await insertAsync("job_application_sheet_mirrors", values);
  }
  return { row, syncStatus: "prepared", blocker: "sheets_connector_unverified" };
}

/**
 * Parse the native cell readback emitted by the official Sheets connector.
 * The server accepts only the AOS候補 20-column shape; it never accepts a
 * candidate-key-only assertion because that could mark an unrelated sheet as
 * synced.
 */
export function parseSheetMirrorReadbackInput(value: unknown, now = nowIso()): SheetMirrorReadbackInput {
  const body = objectValue(value, "sheet_mirror_sync_body_required");
  const allowed = new Set(["schema", "spreadsheet_id", "sheet_id", "sheet_name", "range", "readback_at", "rows"]);
  for (const key of Object.keys(body)) if (!allowed.has(key)) throw new JobApplicationOperationsError("sheet_mirror_sync_unknown_field");
  if (body.schema !== JOB_APPLICATION_SHEET_MIRROR_SYNC_SCHEMA) throw new JobApplicationOperationsError("sheet_mirror_sync_schema_invalid");
  const spreadsheetId = requiredRef(body.spreadsheet_id, "sheet_mirror_sync_spreadsheet_id_required");
  const sheetId = requiredRef(String(body.sheet_id ?? ""), "sheet_mirror_sync_sheet_id_required");
  const sheetName = requiredText(body.sheet_name, "sheet_mirror_sync_sheet_name_required", 120);
  const range = requiredText(body.range, "sheet_mirror_sync_range_required", 240);
  const readbackAt = requiredText(body.readback_at, "sheet_mirror_sync_readback_at_required", 80);
  if (!Number.isFinite(Date.parse(readbackAt)) || Date.parse(readbackAt) > Date.parse(now) + 60_000) throw new JobApplicationOperationsError("sheet_mirror_sync_readback_at_invalid");
  if (!Array.isArray(body.rows) || body.rows.length > 500) throw new JobApplicationOperationsError("sheet_mirror_sync_rows_invalid");
  const rows = body.rows.map((raw, index) => {
    const row = objectValue(raw, "sheet_mirror_sync_row_invalid");
    const rowAllowed = new Set(["row_number", "values"]);
    for (const key of Object.keys(row)) if (!rowAllowed.has(key)) throw new JobApplicationOperationsError("sheet_mirror_sync_row_unknown_field");
    const rowNumber = typeof row.row_number === "number" && Number.isSafeInteger(row.row_number) ? row.row_number : Number(row.row_number);
    if (!Number.isSafeInteger(rowNumber) || rowNumber < 2) throw new JobApplicationOperationsError(`sheet_mirror_sync_row_number_invalid:${index}`);
    if (!Array.isArray(row.values) || row.values.length !== 20) throw new JobApplicationOperationsError(`sheet_mirror_sync_row_values_invalid:${index}`);
    return { rowNumber, values: row.values };
  });
  return { schema: JOB_APPLICATION_SHEET_MIRROR_SYNC_SCHEMA, spreadsheetId, sheetId, sheetName, range, readbackAt: new Date(Date.parse(readbackAt)).toISOString(), rows };
}

/** The stable AOS候補 column order used for both write and sync readback. */
export function sheetMirrorReadbackValues(candidate: CandidateSupplyRecord): readonly unknown[] {
  return [
    candidate.candidateKey,
    candidate.sourceSnapshotId,
    candidate.sourceSnapshotExpiresAt,
    candidate.companyName,
    candidate.role,
    candidate.jobUrl,
    candidate.applicationUrl,
    candidate.language,
    candidate.remoteMode,
    candidate.workLocation,
    candidate.workAuthorization,
    candidate.salaryJpy,
    candidate.salaryOriginalMin,
    candidate.salaryOriginalMax,
    candidate.salaryCurrency,
    candidate.salaryPeriod,
    candidate.salarySourceUrl,
    candidate.status,
    candidate.blocker,
    candidate.nextAction
  ];
}

/**
 * Verify the complete current candidate supply and prepare an atomic internal
 * status update. The caller wraps resourceSteps in the shared idempotency
 * boundary before executing them.
 */
export function planSheetMirrorSync(companyId: string, candidates: readonly CandidateSupplyRecord[], input: SheetMirrorReadbackInput, now = nowIso()): SheetMirrorSyncPlan {
  if (input.rows.length !== candidates.length) throw new JobApplicationOperationsError("sheet_mirror_sync_candidate_count_mismatch");
  const expected = new Map(candidates.map((candidate) => [candidate.candidateKey, candidate]));
  const seen = new Set<string>();
  const matched: Array<{ candidate: CandidateSupplyRecord; rowNumber: number; fingerprint: string }> = [];
  for (const row of input.rows) {
    const candidateKey = requiredCellText(row.values[0], "sheet_mirror_sync_candidate_key_invalid", 400);
    if (seen.has(candidateKey)) throw new JobApplicationOperationsError("sheet_mirror_sync_duplicate_candidate_key");
    seen.add(candidateKey);
    const candidate = expected.get(candidateKey);
    if (!candidate) throw new JobApplicationOperationsError("sheet_mirror_sync_unknown_candidate_key");
    const normalized = normalizeSheetMirrorValues(row.values);
    const expectedValues = sheetMirrorReadbackValues(candidate);
    const fingerprint = sha256(JSON.stringify(normalized));
    if (fingerprint !== sha256(JSON.stringify(expectedValues))) throw new JobApplicationOperationsError(`sheet_mirror_sync_readback_mismatch:${candidateKey}`);
    matched.push({ candidate, rowNumber: row.rowNumber, fingerprint });
  }
  if (seen.size !== expected.size) throw new JobApplicationOperationsError("sheet_mirror_sync_missing_candidate_key");
  const steps = matched.map(({ candidate }) => {
    const prepared = prepareSheetMirror(companyId, candidate);
    const sync = {
        schema: JOB_APPLICATION_SHEET_MIRROR_SYNC_SCHEMA,
        spreadsheet_id: input.spreadsheetId,
        sheet_id: input.sheetId,
        sheet_name: input.sheetName,
        range: input.range,
        readback_at: input.readbackAt
      };
    const syncRow = buildSheetMirrorPayload(companyId, candidate, prepared, sync);
    const id = `job_sheet_mirror_${sha256(`${companyId}:${candidate.candidateKey}`).slice(0, 32)}`;
    return {
      sql: `UPDATE job_application_sheet_mirrors SET row_json=${sqlValue(JSON.stringify(syncRow))}, row_fingerprint=${sqlValue(sha256(JSON.stringify(prepared)))}, sync_status='synced', blocker=NULL, updated_at=${sqlValue(now)} WHERE id=${sqlValue(id)} AND company_id=${sqlValue(companyId)} AND candidate_key=${sqlValue(candidate.candidateKey)} AND EXISTS (SELECT 1 FROM job_application_candidate_supply candidate_current WHERE candidate_current.company_id=${sqlValue(companyId)} AND candidate_current.candidate_key=${sqlValue(candidate.candidateKey)} AND candidate_current.target_digest=${sqlValue(candidate.targetDigest)} AND candidate_current.updated_at=${sqlValue(candidate.updatedAt)})`,
      expectChanges: 1
    };
  });
  return {
    rowsSynced: matched.length,
    readbackFingerprint: sha256(JSON.stringify(matched.sort((a, b) => a.candidate.candidateKey.localeCompare(b.candidate.candidateKey)).map((row) => ({ candidate_key: row.candidate.candidateKey, row_number: row.rowNumber, fingerprint: row.fingerprint })))),
    resourceSteps: steps
  };
}

export function listSheetMirrorStatuses(companyId: string): Array<{ syncStatus: string; blocker: string | null }> {
  return querySql<{ sync_status: string; blocker: string | null }>(`SELECT sync_status, blocker FROM job_application_sheet_mirrors WHERE company_id=${sqlValue(companyId)} ORDER BY updated_at DESC LIMIT 500`).map((row) => ({ syncStatus: row.sync_status, blocker: row.blocker }));
}

export async function listSheetMirrorStatusesAsync(companyId: string): Promise<Array<{ syncStatus: string; blocker: string | null }>> {
  return (await querySqlAsync<{ sync_status: string; blocker: string | null }>(`SELECT sync_status, blocker FROM job_application_sheet_mirrors WHERE company_id=${sqlValue(companyId)} ORDER BY updated_at DESC LIMIT 500`)).map((row) => ({ syncStatus: row.sync_status, blocker: row.blocker }));
}

export function buildJobApplicationDigest(input: DigestInput): JobApplicationDigest {
  const blockers: Record<string, number> = {};
  const add = (key: string, amount = 1) => { blockers[key] = (blockers[key] ?? 0) + amount; };
  const successes = input.admissions.filter((row) => row.status === "reconciled").length;
  const awaiting = input.admissions.filter((row) => ["submitted", "running"].includes(String(row.status ?? ""))).length;
  const admissionStopped = input.admissions.filter((row) => ["blocked", "rejected", "cancelled", "expired"].includes(String(row.status ?? ""))).length;
  const duplicateExcluded = input.candidates.filter((row) => row.status === "duplicate_excluded").length;
  const salaryEvidenceMissing = input.candidates.filter((row) => row.blocker?.includes("salary_evidence_missing")).length;
  const salaryAnnualThresholdUnproven = input.candidates.filter((row) => row.blocker?.includes("annual_salary_threshold_not_proven_from_hourly_contract_range") || row.blocker?.includes("salary_period_unverified")).length;
  const salaryBelow = input.candidates.filter((row) => row.blocker?.includes("salary_below_threshold")).length;
  const candidateStopped = input.candidates.filter((row) => row.status === "blocked" || row.status === "duplicate_excluded").length;
  for (const row of input.candidates) for (const blocker of String(row.blocker ?? "").split(",").map((value) => value.trim()).filter(Boolean)) add(blocker);
  if (input.sheetMirrors) for (const mirror of input.sheetMirrors) if (mirror.syncStatus === "failed" || mirror.blocker) add(mirror.blocker ?? "sheets_sync_failed");
  if (awaiting) add("same_run_reconciliation_pending", awaiting);
  if (input.delayedQueueCount) add("delayed_queue", input.delayedQueueCount);
  const stopped = candidateStopped + admissionStopped;
  return {
    schema: "aos.job_application_digest.v1",
    date_jst: input.dateKey ?? jstDateKey(nowIso()),
    target: JOB_APPLICATION_DAILY_TARGET,
    cumulative_target: JOB_APPLICATION_CUMULATIVE_TARGET,
    cumulative_success: input.historicalSuccessCount ?? null,
    candidate_count: input.candidates.length,
    eligible_candidate_count: input.candidates.filter((row) => ["eligible", "admitted"].includes(row.status)).length,
    success_count: successes,
    stopped_count: stopped,
    awaiting_reconciliation_count: awaiting,
    duplicate_excluded_count: duplicateExcluded,
    salary_evidence_missing_count: salaryEvidenceMissing,
    salary_annual_threshold_unproven_count: salaryAnnualThresholdUnproven,
    salary_below_threshold_count: salaryBelow,
    sheet_sync_failed_count: input.sheetMirrors?.filter((row) => row.syncStatus === "failed").length ?? 0,
    delayed_queue_count: input.delayedQueueCount ?? null,
    blockers,
    next_action: awaiting ? "外部効果を再送せず、同一Runのprovider/source readbackを照合する" : stopped ? "停止理由を確認し、条件を満たすfresh候補だけを次に進める" : "fresh候補を確認し、今日の上限20件までtarget admissionを段階的に進める",
    external_action_executed: false
  };
}

export function candidateToSheetMirrorRow(candidate: CandidateSupplyRecord): SheetMirrorRow {
  return prepareSheetMirror(candidate.companyId, candidate);
}

function candidateFromRow(row: Record<string, unknown>): CandidateSupplyRecord {
  const role = String(row.role);
  const storedPeriod = String(row.salary_period ?? "annual") as CandidateSalaryPeriod;
  const salaryPeriod = storedPeriod === "annual" && isLegacyHourlyRole(role) ? "hourly" : storedPeriod;
  const legacyHourly = salaryPeriod === "hourly" && storedPeriod !== "hourly";
  const legacyHourlyBlocker = legacyHourly ? "annual_salary_threshold_not_proven_from_hourly_contract_range" : nullableString(row.blocker);
  return {
    candidateKey: String(row.candidate_key), sourceSnapshotId: String(row.source_snapshot_id), sourceSnapshotExpiresAt: String(row.source_snapshot_expires_at), supplyRunId: String(row.supply_run_id), jobUrl: nullableString(row.job_url), jobId: nullableString(row.job_id), applicationUrl: nullableString(row.application_url), companyName: String(row.company_name), role, language: String(row.language) === "en" ? "en" : "ja", salaryOriginalMin: nullableNumeric(row.salary_original_min), salaryOriginalMax: nullableNumeric(row.salary_original_max), salaryCurrency: String(row.salary_currency), salaryPeriod, fxToJpy: nullableNumeric(row.fx_to_jpy), salarySourceUrl: nullableString(row.salary_source_url), fxSourceUrl: nullableString(row.fx_source_url), salarySourceTime: nullableString(row.salary_source_time), workLocation: String(row.work_location) as CandidateWorkLocation, workAuthorization: String(row.work_authorization) as CandidateWorkAuthorization, remoteMode: String(row.remote_mode) as CandidateRemoteMode,
    id: String(row.id), companyId: String(row.company_id), resumeLocale: String(row.resume_locale) === "en-US" ? "en-US" : "ja-JP", salaryJpy: legacyHourly ? null : nullableNumeric(row.salary_jpy), dedupeKey: String(row.dedupe_key), status: legacyHourly ? "blocked" : String(row.status) as CandidateStatus, blocker: legacyHourly ? legacyHourlyBlocker : nullableString(row.blocker), nextAction: legacyHourly ? "時給を年収へ換算する契約時間根拠がないため、年収根拠を確認してから進む" : String(row.next_action), targetDigest: String(row.target_digest), createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
}

function candidateToRow(record: CandidateSupplyRecord): Record<string, string | number | null> {
  return { id: record.id, company_id: record.companyId, candidate_key: record.candidateKey, source_snapshot_id: record.sourceSnapshotId, source_snapshot_expires_at: record.sourceSnapshotExpiresAt, supply_run_id: record.supplyRunId, job_url: record.jobUrl, job_id: record.jobId, application_url: record.applicationUrl, company_name: record.companyName, role: record.role, language: record.language, resume_locale: record.resumeLocale, salary_original_min: record.salaryOriginalMin, salary_original_max: record.salaryOriginalMax, salary_currency: record.salaryCurrency, salary_period: record.salaryPeriod, fx_to_jpy: record.fxToJpy, salary_jpy: record.salaryJpy, salary_source_url: record.salarySourceUrl, fx_source_url: record.fxSourceUrl, salary_source_time: record.salarySourceTime, work_location: record.workLocation, work_authorization: record.workAuthorization, remote_mode: record.remoteMode, status: record.status, blocker: record.blocker, next_action: record.nextAction, dedupe_key: record.dedupeKey, target_digest: record.targetDigest, created_at: record.createdAt, updated_at: record.updatedAt };
}

function calculateSalaryJpy(input: CandidateSupplyInput): number | null {
  if (input.salaryOriginalMin === null) return null;
  const rate = input.salaryCurrency === "JPY" ? 1 : input.fxToJpy;
  if (!rate) return null;
  const annualMultiplier = input.salaryPeriod === "annual" ? 1 : input.salaryPeriod === "monthly" ? 12 : input.salaryPeriod === "weekly" ? 52 : 0;
  return annualMultiplier ? Math.floor(input.salaryOriginalMin * rate * annualMultiplier) : null;
}

function isLegacyHourlyRole(role: string): boolean {
  const normalized = role.toLowerCase();
  return normalized.includes("/hr") || normalized.includes("per hour") || normalized.includes("hourly");
}

function createDedupeKey(company: string, role: string): string {
  return sha256(`${normalize(company)}|${normalize(role)}`).slice(0, 40);
}

function normalize(value: string): string { return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, " "); }
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function jstDateKey(value: string): string { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value)); }
function objectValue(value: unknown, code: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new JobApplicationOperationsError(code); return value as Record<string, unknown>; }
function requiredText(value: unknown, code: string, max: number): string { if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new JobApplicationOperationsError(code); return value.trim(); }
function nullableText(value: unknown, max: number): string | null { if (value === undefined || value === null || value === "") return null; return requiredText(value, "candidate_supply_text_invalid", max); }
function requiredRef(value: unknown, code: string): string { const text = requiredText(value, code, 400); if (!SAFE_REF.test(text)) throw new JobApplicationOperationsError(code); return text; }
function nullableRef(value: unknown, code: string): string | null { if (value === undefined || value === null || value === "") return null; return requiredRef(value, code); }
function nullableUrl(value: unknown, code: string): string | null { if (value === undefined || value === null || value === "") return null; if (typeof value !== "string" || !SAFE_URL.test(value.trim())) throw new JobApplicationOperationsError(code); return value.trim(); }
function nullableNumber(value: unknown, code: string): number | null { if (value === undefined || value === null || value === "") return null; const number = typeof value === "number" ? value : Number(value); if (!Number.isFinite(number)) throw new JobApplicationOperationsError(code); return number; }
function futureIso(value: unknown, now: string, code: string): string { const text = requiredText(value, code, 80); const timestamp = Date.parse(text); if (!Number.isFinite(timestamp) || timestamp <= Date.parse(now)) throw new JobApplicationOperationsError(code); return new Date(timestamp).toISOString(); }
function enumValue<T extends string>(value: unknown, allowed: readonly T[], code: string): T { if (typeof value !== "string" || !allowed.includes(value as T)) throw new JobApplicationOperationsError(code); return value as T; }
function nullableString(value: unknown): string | null { return typeof value === "string" && value ? value : null; }
function nullableNumeric(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : value === null || value === undefined || value === "" ? null : Number(value); }

function requiredCellText(value: unknown, code: string, max: number): string {
  if (value === null || value === undefined || value === "") throw new JobApplicationOperationsError(code);
  return requiredText(String(value), code, max);
}

function nullableCellText(value: unknown, code: string, max: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  return requiredText(String(value), code, max);
}

function cellNumber(value: unknown, code: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) throw new JobApplicationOperationsError(code);
  return number;
}

function normalizeSheetMirrorValues(values: readonly unknown[]): readonly unknown[] {
  if (values.length !== 20) throw new JobApplicationOperationsError("sheet_mirror_sync_row_values_invalid");
  return [
    requiredCellText(values[0], "sheet_mirror_sync_candidate_key_invalid", 400),
    requiredCellText(values[1], "sheet_mirror_sync_source_snapshot_id_invalid", 400),
    requiredCellText(values[2], "sheet_mirror_sync_source_expiry_invalid", 80),
    requiredCellText(values[3], "sheet_mirror_sync_company_invalid", 240),
    requiredCellText(values[4], "sheet_mirror_sync_role_invalid", 240),
    nullableUrl(values[5], "sheet_mirror_sync_job_url_invalid"),
    nullableUrl(values[6], "sheet_mirror_sync_application_url_invalid"),
    enumValue(values[7], ["ja", "en"], "sheet_mirror_sync_language_invalid"),
    enumValue(values[8], ["remote", "hybrid", "onsite", "unknown"], "sheet_mirror_sync_remote_mode_invalid"),
    enumValue(values[9], ["japan", "remote_from_japan", "hybrid_japan", "overseas"], "sheet_mirror_sync_work_location_invalid"),
    enumValue(values[10], ["japan_visa", "remote_from_japan_allowed", "unknown", "not_authorized"], "sheet_mirror_sync_work_authorization_invalid"),
    cellNumber(values[11], "sheet_mirror_sync_salary_jpy_invalid"),
    cellNumber(values[12], "sheet_mirror_sync_salary_min_invalid"),
    cellNumber(values[13], "sheet_mirror_sync_salary_max_invalid"),
    requiredCellText(values[14], "sheet_mirror_sync_salary_currency_invalid", 12).toUpperCase(),
    enumValue(values[15], ["annual", "monthly", "weekly", "hourly", "unknown"], "sheet_mirror_sync_salary_period_invalid"),
    nullableUrl(values[16], "sheet_mirror_sync_salary_source_url_invalid"),
    enumValue(values[17], ["eligible", "blocked", "duplicate_excluded", "admitted", "submitted_confirmed", "reconciliation_required", "rejected", "expired"], "sheet_mirror_sync_status_invalid"),
    nullableCellText(values[18], "sheet_mirror_sync_blocker_invalid", 400),
    requiredCellText(values[19], "sheet_mirror_sync_next_action_invalid", 500)
  ];
}

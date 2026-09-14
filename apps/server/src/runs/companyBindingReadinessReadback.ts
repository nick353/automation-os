import { dbBackend, dbPath, nowIso, querySql, querySqlAsync } from "../db/client.js";
import {
  buildCompanyBindingReadinessV1,
  DEFAULT_CODEX_TRIGGER_COMPANY_ID,
  type CompanyBindingReadinessDatabaseInput,
  type CompanyBindingReadinessScheduleInput
} from "./companyBindingReadiness.js";
import { classifyPortableWorkerHeartbeat, resolvePortableWorkerHeartbeatAt } from "./portableWorkerHeartbeat.js";
import { buildBrowserRuntimeProcessReadbackAsync, sanitizePortableRemoteWorkerHeartbeat } from "../browser/liveResourceReadback.js";
import { readConfiguredCanonicalCompanyAuthority } from "./companyBindingReconciliation.js";

type CompanyRow = { company_id: string; automation_count: number | string };
type ScheduleRow = CompanyBindingReadinessScheduleInput & { automation_name: string | null };
type AccountRow = { id: string; company_id: string; platform: string; status: string; verification_status: string };
type CountRow = { count: number | string };
type PortableHeartbeatRow = { status: string; created_at: string; metadata_json: unknown };

const COUNT_TABLES = [
  ["companies", "companies", "id"],
  ["mvp_automations", "mvp_automations", "company_id"],
  ["mvp_automation_schedules", "mvp_automation_schedules", "company_id"],
  ["runs", "runs", "company_id"],
  ["proofs", "proofs", "company_id"],
  ["durable_jobs", "durable_jobs", "company_id"],
  ["durable_schedule_occurrences", "durable_schedule_occurrences", "company_id"],
  ["worker_events", "worker_events", "company_id"],
  ["task_effect_ledger", "task_effect_ledger", "company_id"]
] as const;

async function readRows<T>(sql: string): Promise<T[]> {
  return dbBackend === "postgres" ? querySqlAsync<T>(sql) : querySql<T>(sql);
}

async function readCount(table: string, companyColumn: string, companyId: string | null): Promise<number | null> {
  try {
    const where = companyId ? ` WHERE ${companyColumn}=${sqlValue(companyId)}` : "";
    const row = (await readRows<CountRow>(`SELECT COUNT(*) AS count FROM ${table}${where}`))[0];
    const count = Number(row?.count);
    return Number.isSafeInteger(count) && count >= 0 ? count : null;
  } catch {
    return null;
  }
}

async function readIntegrity(): Promise<string | null> {
  if (dbBackend === "postgres") return "not_applicable";
  try {
    const row = (await readRows<{ integrity_check: string }>("PRAGMA integrity_check"))[0];
    return row?.integrity_check ?? null;
  } catch {
    return null;
  }
}

/**
 * Read the current company-binding readiness through the existing control
 * plane. All queries are read-only and the result is a diagnostic contract,
 * not a production authority or scheduler admission.
 */
export async function readCompanyBindingReadinessV1(options: {
  now?: string;
  companyId?: string | null;
  triggerCompanyId?: string | null;
  graphReceiptStatus?: "none" | "fresh" | "stale_or_tampered";
} = {}) {
  const now = options.now ?? nowIso();
  const companyId = options.companyId?.trim() || null;
  const companyPredicate = companyId ? ` AND company_id=${sqlValue(companyId)}` : "";
  const schedulePredicate = companyId ? ` WHERE schedule.company_id=${sqlValue(companyId)}` : "";
  const accountPredicate = companyId ? ` WHERE company_id=${sqlValue(companyId)}` : "";
  const [companies, schedules, accountRefs, integrity, countValues, heartbeatRows] = await Promise.all([
    readRows<CompanyRow>(`
      SELECT company_id, COUNT(*) AS automation_count
      FROM mvp_automations
      WHERE trim(company_id)!=''${companyPredicate}
      GROUP BY company_id
      ORDER BY company_id
    `),
    readRows<ScheduleRow>(`
      SELECT schedule.id, schedule.company_id, schedule.automation_id, automation.name AS automation_name,
             CASE WHEN automation.worker_command_kind IN ('local_backup_registered', 'obsidian_audit_registered')
                  THEN 'local_only' ELSE 'provider_browser' END AS execution_lane,
             schedule.kind, schedule.expression, schedule.timezone, schedule.enabled, schedule.status,
             schedule.revision, schedule.next_run_at, schedule.last_run_at, schedule.catch_up_policy
      FROM mvp_automation_schedules schedule
      JOIN mvp_automations automation
        ON automation.id=schedule.automation_id AND automation.company_id=schedule.company_id
      ${schedulePredicate}
      ORDER BY schedule.company_id, schedule.id
    `),
    readRows<AccountRow>(`
      SELECT id, company_id, platform, status, verification_status
      FROM company_connection_account_refs
      ${accountPredicate}
      ORDER BY company_id, id
    `),
    readIntegrity(),
    Promise.all(COUNT_TABLES.map(async ([key, table, companyColumn]) => [key, await readCount(table, companyColumn, companyId)] as const)),
    readRows<PortableHeartbeatRow>(`SELECT status, created_at, metadata_json FROM system_checks WHERE kind='portable_mac_worker' ORDER BY created_at DESC LIMIT 100`)
  ]);
  const counts = Object.fromEntries(countValues) as Record<string, number | null>;
  const serviceUserId = process.env.AUTOMATION_OS_DURABLE_SERVICE_USER_ID?.trim() ?? "";
  let serviceIdentityConfigured = false;
  if (serviceUserId) {
    const serviceUser = await readRows<{ id: string }>(`
      SELECT id FROM users
      WHERE id=${sqlValue(serviceUserId)} AND kind='service' AND status='active'
      LIMIT 1
    `);
    const membership = await readRows<{ id: string }>(`
      SELECT company_memberships.id
      FROM company_memberships
      JOIN users ON users.id=company_memberships.user_id
      WHERE company_memberships.user_id=${sqlValue(serviceUserId)}
        ${companyId ? `AND company_memberships.company_id=${sqlValue(companyId)}` : ""}
        AND company_memberships.role='operator'
        AND company_memberships.status='active'
        AND users.status='active'
      LIMIT 1
    `);
    serviceIdentityConfigured = serviceUser.length > 0 && membership.length > 0;
  }
  const localCompanyId = companies.length === 1 ? companies[0]?.company_id ?? null : null;
  const canonicalAuthority = readConfiguredCanonicalCompanyAuthority();
  const persistedHeartbeat = heartbeatRows
    .map((row) => {
      const metadata = parseJsonObject(row.metadata_json);
      const metadataCompanyId = typeof metadata.company_id === "string" ? metadata.company_id.trim() : "";
      const readback = metadataCompanyId
        ? sanitizePortableRemoteWorkerHeartbeat(metadata, {
          fallbackCompanyId: metadataCompanyId,
          fallbackHeartbeatAt: row.created_at
        })
        : null;
      return { row, metadata, readback, metadataCompanyId };
    })
    .find((candidate) => candidate.readback && (!companyId || candidate.metadataCompanyId === companyId)) ?? null;
  const liveProcessReadback = await buildBrowserRuntimeProcessReadbackAsync({
    controlPlaneCompanyIds: companies.map((row) => row.company_id),
    remoteWorkerHeartbeat: persistedHeartbeat?.readback ?? null
  });
  const portableWorker = liveProcessReadback.portableRemoteWorker;
  const workerCompanyIds = [...new Set(portableWorker.processes
    .map((row) => row.remoteCompanyId)
    .filter((value): value is string => typeof value === "string" && value.trim() !== ""))];
  if (portableWorker.remoteReport?.companyId && !workerCompanyIds.includes(portableWorker.remoteReport.companyId)) {
    workerCompanyIds.push(portableWorker.remoteReport.companyId);
  }
  const heartbeatAt = resolvePortableWorkerHeartbeatAt({
    liveLastSuccessfulHeartbeatAt: portableWorker.transportReadback.lastSuccessfulHeartbeatAt,
    liveHeartbeatAt: portableWorker.transportReadback.heartbeatAt
  });
  const heartbeatFresh = heartbeatAt
    ? classifyPortableWorkerHeartbeat({
      heartbeatAt,
      staleAfterSeconds: Number(process.env.AUTOMATION_OS_PORTABLE_WORKER_HEARTBEAT_STALE_SECONDS ?? 300)
    }).heartbeatFresh
    : false;
  const workerCompanyId = workerCompanyIds.length === 1 ? workerCompanyIds[0] : null;
  const workerAuthorityFresh = workerCompanyId !== null
    && heartbeatFresh
    && portableWorker.scopeReadback.status === "matched"
    && portableWorker.scopeReadback.exactBlocker === null
    && portableWorker.scopeReadback.identityStatus === "verified";
  const localCanonicalSelection = canonicalAuthority?.applied === true
    && canonicalAuthority.endpoint === "http://localhost:8787"
    && canonicalAuthority.company_id === companyId;
  const briefDeliveryConfigured = process.env.AOS_BRIEF_DELIVERY_MODE === "home_only";
  const database: CompanyBindingReadinessDatabaseInput = {
    backend: dbBackend,
    path: dbBackend === "sqlite" ? dbPath : null,
    integrity,
    counts,
    stable: null
  };
  const readiness = buildCompanyBindingReadinessV1({
    now,
    trigger_company_id: options.triggerCompanyId ?? process.env.AOS_TRIGGER_PARITY_COMPANY_ID ?? DEFAULT_CODEX_TRIGGER_COMPANY_ID,
    trigger_provenance: "codex_app_registered_trigger_readback",
    local_companies: companies.map((row) => ({
      company_id: row.company_id,
      automation_count: Number(row.automation_count),
      provenance: "local_diagnostic_sql_readback"
    })),
    schedules,
    account_refs: accountRefs,
    service_identity: {
      configured: serviceIdentityConfigured,
      source: serviceUserId ? "environment_plus_active_operator_membership_readback" : "missing_environment_service_identity"
    },
    canonical_company_id: canonicalAuthority?.applied === true ? canonicalAuthority.company_id : null,
    canonical_authority_fresh: canonicalAuthority?.fresh === true && canonicalAuthority.applied === true,
    source_company_id: localCompanyId,
    source_authority_fresh: localCompanyId !== null,
    worker_company_id: workerCompanyId,
    worker_authority_fresh: workerAuthorityFresh,
    runtime_company_id: localCanonicalSelection ? companyId : null,
    runtime_authority_fresh: localCanonicalSelection,
    provider_authority_fresh: false,
    browser_authority_fresh: false,
    provider_receipt_contract_ready: false,
    source_sync_contract_ready: false,
    reconciliation_contract_ready: false,
    cleanup_contract_ready: false,
    brief_home_readback_available: true,
    brief_delivery_configured: briefDeliveryConfigured,
    chat_consultation_available: true,
    chat_read_only_demo_available: true,
    chat_approval_preview_available: true,
    chat_registration_ready: canonicalAuthority?.applied === true && canonicalAuthority.company_id === companyId,
    graph_receipt_status: options.graphReceiptStatus ?? "none",
    database
  });
  return {
    ...readiness,
    worker_identity_readback: {
      status: portableWorker.scopeReadback.identityStatus,
      company_id: portableWorker.remoteReport?.companyId ?? workerCompanyId,
      worker_id: portableWorker.remoteReport?.workerId ?? portableWorker.transportReadback.workerId,
      worker_instance_id: portableWorker.remoteReport?.workerInstanceId ?? portableWorker.transportReadback.workerInstanceId,
      generation: portableWorker.remoteReport?.generation ?? portableWorker.transportReadback.generation,
      observed_at: portableWorker.remoteReport?.observedAt ?? portableWorker.transportReadback.observedAt,
      heartbeat_at: heartbeatAt,
      readback_status: portableWorker.remoteReport?.readbackStatus ?? "not_observed",
      exact_blocker: portableWorker.scopeReadback.exactBlocker
    }
  };
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function sqlValue(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

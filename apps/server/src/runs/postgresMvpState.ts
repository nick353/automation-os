import pg from "pg";
import { sanitizeDashboardRows } from "../dashboardSanitizer.js";
import { automationExecutionContract } from "../automations/executionContract.js";
import { resolveGmailExecutionTarget } from "./gmailAccountBinding.js";
import type { CompanyConnectionRefRecord } from "../automations/repository.js";
import { buildProjectPresentationProfile, restoreProjectPresentationProfile } from "../projects/presentationProfile.js";
import { buildBrowserRuntimeProcessReadbackAsync, sanitizePortableRemoteWorkerHeartbeat, type PortableRemoteWorkerHeartbeatReadback } from "../browser/liveResourceReadback.js";
import { buildBrowserUseRuntimeSnapshotAsync, publicBrowserUseLaneBinding } from "../browser/runtimeSnapshot.js";
import { registeredBrowserLaneForWorkflow } from "./laneManager.js";
import { classifyPortableWorkerHeartbeat, resolvePortableWorkerHeartbeatAt } from "./portableWorkerHeartbeat.js";
import { browserSurfaceForWebOperationBackend, resolveWebOperationBackend } from "./webOperationBackendSettings.js";
import { projectMvpStateForChat, projectMvpStateForUi, type MvpStateProjection } from "./mvpStateProjection.js";

type JsonObject = Record<string, unknown>;

export type PostgresMvpStateOptions = {
  companyId?: string;
  actorUserId?: string;
  queryClient?: PostgresMvpStateQueryClient;
  projection?: MvpStateProjection;
  /** Bypass the bounded UI cache for an explicit user refresh or post-write readback. */
  forceFresh?: boolean;
  /** Optional read-only diagnostics sink used by the HTTP Server-Timing header. */
  timing?: MvpStateReadTiming;
};

export type MvpStateReadTiming = {
  projection?: MvpStateProjection;
  cacheStatus?: "fresh" | "cached" | "in_flight";
  membershipMs?: number;
  dbFanoutMs?: number;
  mappingMs?: number;
  runtimeSnapshotMs?: number;
  totalMs?: number;
  queryCount?: number;
  queryTimings?: Array<{ label: string; durationMs: number; rowCount: number; status: "ok" | "error" }>;
};

/**
 * The dashboard's first request is unscoped unless the service is explicitly
 * pinned to a company. Keep startup warm-up aligned with the UI projection so
 * a cold server does not make the UI wait for the heavier full read-only fan-
 * out used by detail/CLI callers.
 */
export function startupMvpStateWarmupOptions(env: NodeJS.ProcessEnv = process.env): Pick<PostgresMvpStateOptions, "companyId"> {
  const companyId = env.AUTOMATION_OS_COMPANY_ID?.trim();
  return companyId ? { companyId } : {};
}

export type PostgresMvpStateQueryClient = {
  query(text: string, values?: unknown[]): Promise<{ rows: JsonObject[] }>;
};

let pool: pg.Pool | undefined;
let warmupPromise: Promise<void> | undefined;
const stateCache = new Map<string, { state: JsonObject; expiresAt: number }>();
const stateInFlight = new Map<string, Promise<JsonObject>>();
const FULL_STATE_CACHE_TTL_MS = 5_000;
const UI_STATE_CACHE_TTL_MS = 15_000;
const CHAT_STATE_CACHE_TTL_MS = 15_000;
const SUMMARY_STATE_CACHE_TTL_MS = 60_000;
const DEFAULT_STATE_POOL_MAX = 12;
// The UI list sanitizer keeps only these metadata keys. Project that bounded
// shape in PostgreSQL so the list read never transfers full receipts and
// workflow payloads for all 500 rows. Detail/full callers still select the
// lossless metadata_json column.
const UI_RUN_METADATA_COLUMN = `(SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
    FROM jsonb_each(jsonb_build_object(
      'adapter', metadata_json::jsonb -> 'adapter',
      'approval_required_reason', metadata_json::jsonb -> 'approval_required_reason',
      'browser_surface', metadata_json::jsonb -> 'browser_surface',
      'business_completion_verified', metadata_json::jsonb -> 'business_completion_verified',
      'cleanup_verified', metadata_json::jsonb -> 'cleanup_verified',
      'dry_run', metadata_json::jsonb -> 'dry_run',
      'effect_stage', metadata_json::jsonb -> 'effect_stage',
      'exact_blocker', metadata_json::jsonb -> 'exact_blocker',
      'execution_mode', metadata_json::jsonb -> 'execution_mode',
      'external_action_executed', metadata_json::jsonb -> 'external_action_executed',
      'fallback_allowed', metadata_json::jsonb -> 'fallback_allowed',
      'proof_gate', metadata_json::jsonb -> 'proof_gate',
      'read_only_stage', metadata_json::jsonb -> 'read_only_stage',
      'readback_verified', metadata_json::jsonb -> 'readback_verified',
      'requires_approval', metadata_json::jsonb -> 'requires_approval',
      'run_contract', metadata_json::jsonb -> 'run_contract',
      'run_contract_summary', metadata_json::jsonb -> 'run_contract_summary',
      'same_run_receipt', metadata_json::jsonb -> 'same_run_receipt',
      'status', metadata_json::jsonb -> 'status',
      'stop_reason', metadata_json::jsonb -> 'stop_reason',
      'web_operation_backend', metadata_json::jsonb -> 'web_operation_backend',
      'worker_mode', metadata_json::jsonb -> 'worker_mode',
      'workflow_id', metadata_json::jsonb -> 'workflow_id',
      'workflowId', metadata_json::jsonb -> 'workflowId'
    )) AS entry(key, value)
    WHERE entry.value <> 'null'::jsonb OR metadata_json::jsonb ? entry.key)::text AS metadata_json`;
// Proof-list sanitization only reads the safe external-action boundary. Keep
// the nested receipt flag, but never pull the full proof metadata blob into
// the dashboard fan-out; the detail route remains lossless.
const UI_PROOF_METADATA_COLUMN = `jsonb_strip_nulls(jsonb_build_object(
      'external_action_executed', proofs.metadata_json::jsonb -> 'external_action_executed',
      'receipt', jsonb_strip_nulls(jsonb_build_object(
        'external_action_executed', proofs.metadata_json::jsonb -> 'receipt' -> 'external_action_executed'
      ))
    ))::text AS metadata_json`;
// A dashboard read must fail closed before the web client gives up. The UI
// aborts a state request after 30 seconds. A 10-second server bound
// was shorter than the first cold scoped fan-out on the current Postgres
// service, so the UI could report a blocker even though the same read-only
// query completed immediately after the pool was warm. Keep a bounded margin
// below the UI limit while allowing one cold pool/fan-out to finish.
const DEFAULT_STATE_QUERY_TIMEOUT_MS = 20_000;
export const QUEUED_JOB_HISTORICAL_AFTER_MS = 24 * 60 * 60 * 1000;

export type QueuedJobFreshness = "fresh" | "historical" | "unknown" | "not_queued";

export function classifyQueuedJobFreshness(input: {
  status: unknown;
  availableAt?: unknown;
  createdAt?: unknown;
  nowMs?: number;
}): QueuedJobFreshness {
  if (String(input.status ?? "") !== "queued") return "not_queued";
  const timestamp = String(input.availableAt ?? input.createdAt ?? "").trim();
  const queuedAtMs = Date.parse(timestamp);
  if (!Number.isFinite(queuedAtMs)) return "unknown";
  const nowMs = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now();
  return nowMs - queuedAtMs > QUEUED_JOB_HISTORICAL_AFTER_MS ? "historical" : "fresh";
}

function boundedStatePoolMax(): number {
  const configured = Number(process.env.AUTOMATION_OS_POSTGRES_MVP_STATE_POOL_MAX ?? DEFAULT_STATE_POOL_MAX);
  return Number.isInteger(configured) && configured >= 4 && configured <= 32
    ? configured
    : DEFAULT_STATE_POOL_MAX;
}

export function postgresMvpStateQueryTimeoutMs(): number {
  const configured = Number(
    process.env.AUTOMATION_OS_POSTGRES_MVP_STATE_QUERY_TIMEOUT_MS ?? DEFAULT_STATE_QUERY_TIMEOUT_MS
  );
  return Number.isInteger(configured) && configured >= 5_000 && configured <= 120_000
    ? configured
    : DEFAULT_STATE_QUERY_TIMEOUT_MS;
}

export function postgresMvpStateCacheTtlMs(projection: MvpStateProjection = "full"): number {
  if (projection === "ui") return UI_STATE_CACHE_TTL_MS;
  if (projection === "chat") return CHAT_STATE_CACHE_TTL_MS;
  if (projection === "summary") return SUMMARY_STATE_CACHE_TTL_MS;
  return FULL_STATE_CACHE_TTL_MS;
}

export function classifyPostgresMvpStateError(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  if (message === "Query read timeout" || code === "ETIMEDOUT" || /connection.*timeout|timeout.*connection/i.test(message)) {
    return "mvp_state_postgres_read_timeout";
  }
  return null;
}

function getPool(): pg.Pool {
  if (pool) return pool;
  const databaseUrl = process.env.AUTOMATION_OS_DATABASE_URL ?? process.env.DATABASE_URL ?? process.env.POSTGRES_URI;
  if (!databaseUrl) throw new Error("postgres_database_url_missing");
  pool = new pg.Pool({
    connectionString: databaseUrl,
    // The MVP state read is an intentionally read-only fan-out across the
    // control-plane tables.  Four connections serialized the 15 queries into
    // several waves, making the dashboard appear hung even though the HTTP
    // event loop was no longer blocked.  Keep this pool isolated and bounded
    // so the state fan-out can finish concurrently without changing the
    // smaller write/request pool used by the rest of the server.
    max: boundedStatePoolMax(),
    idleTimeoutMillis: 300_000,
    connectionTimeoutMillis: Math.min(20_000, postgresMvpStateQueryTimeoutMs()),
    query_timeout: postgresMvpStateQueryTimeoutMs(),
    statement_timeout: postgresMvpStateQueryTimeoutMs(),
    allowExitOnIdle: true
  });
  return pool;
}

export function warmPostgresMvpStatePool(): Promise<void> {
  if (warmupPromise) return warmupPromise;
  warmupPromise = getPool()
    .query("SELECT 1 AS ok")
    .then(() => undefined)
    .catch((error) => {
      warmupPromise = undefined;
      throw error;
    });
  return warmupPromise;
}

/** Warm the scoped dashboard snapshot without delaying server readiness. */
export function warmPostgresMvpState(options: PostgresMvpStateOptions = {}): Promise<void> {
  return readPostgresMvpState(options).then(() => undefined);
}

export async function readPostgresMvpState(options: PostgresMvpStateOptions = {}): Promise<JsonObject> {
  const startedAt = Date.now();
  const actorUserId = options.actorUserId?.trim() || process.env.AUTOMATION_OS_OWNER_USER_ID?.trim() || "user_local_owner";
  // UI and full projections intentionally select different column sets. Keep
  // their cache/in-flight entries separate so a fast UI warm-up cannot serve
  // a truncated row to a later detail/full readback (or make the UI wait on a
  // heavier full-projection warm-up).
  const projection = options.projection ?? "full";
  if (options.timing) options.timing.projection = projection;
  const cacheKey = `${actorUserId}\n${options.companyId?.trim() ?? ""}\n${projection}`;
  const cacheTtlMs = postgresMvpStateCacheTtlMs(projection);
  const now = Date.now();
  const cached = stateCache.get(cacheKey);
  if (!options.forceFresh && cached && cached.expiresAt > now) {
    if (options.timing) {
      options.timing.cacheStatus = "cached";
      options.timing.totalMs = Date.now() - startedAt;
    }
    const state = {
      ...cached.state,
      readback_cache: {
        status: "cached",
        captured_at: cached.state.updated_at,
        max_age_ms: cacheTtlMs
      }
    };
    return options.projection === "ui" ? projectMvpStateForUi(state) : state;
  }
  const running = stateInFlight.get(cacheKey);
  if (running) {
    if (options.timing) options.timing.cacheStatus = "in_flight";
    const state = await running;
    if (options.timing) options.timing.totalMs = Date.now() - startedAt;
    return options.projection === "ui" ? projectMvpStateForUi(state) : state;
  }
  const promise = readPostgresMvpStateUncachedBounded({ ...options, actorUserId })
    .then((state) => {
      stateCache.set(cacheKey, { state, expiresAt: Date.now() + cacheTtlMs });
      return { ...state, readback_cache: { status: "fresh", captured_at: state.updated_at, max_age_ms: cacheTtlMs } };
    })
    .finally(() => {
      stateInFlight.delete(cacheKey);
    });
  stateInFlight.set(cacheKey, promise);
  const state = await promise;
  if (options.timing) {
    options.timing.cacheStatus = "fresh";
    options.timing.totalMs = Date.now() - startedAt;
  }
  return options.projection === "ui" ? projectMvpStateForUi(state) : state;
}

async function readPostgresMvpStateUncachedBounded(options: PostgresMvpStateOptions): Promise<JsonObject> {
  const query = readPostgresMvpStateUncached(options);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<JsonObject>((_, reject) => {
    timer = setTimeout(() => {
      if (!options.queryClient) resetPostgresMvpStatePoolAfterTimeout();
      reject(new Error("Query read timeout"));
    }, postgresMvpStateQueryTimeoutMs());
  });
  try {
    return await Promise.race([query, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function resetPostgresMvpStatePoolAfterTimeout(): void {
  const stalePool = pool;
  pool = undefined;
  warmupPromise = undefined;
  stateCache.clear();
  if (stalePool) void stalePool.end().catch(() => undefined);
}

async function readPostgresMvpStateUncached(options: PostgresMvpStateOptions = {}): Promise<JsonObject> {
    const rawDatabase: PostgresMvpStateQueryClient = options.queryClient ?? getPool() as unknown as PostgresMvpStateQueryClient;
    const database = timedQueryClient(rawDatabase, options.timing);
    const actorUserId = options.actorUserId?.trim() || process.env.AUTOMATION_OS_OWNER_USER_ID?.trim() || "user_local_owner";
    const membershipStartedAt = Date.now();
    const companiesResult = await database.query(
      `SELECT companies.id, companies.slug, companies.name, companies.status,
              company_memberships.role, companies.created_at, companies.updated_at
       FROM company_memberships
       JOIN companies ON companies.id=company_memberships.company_id
       JOIN users ON users.id=company_memberships.user_id
       WHERE company_memberships.user_id=$1
         AND company_memberships.status='active'
         AND companies.status <> 'archived'
         AND users.status='active'
       ORDER BY lower(companies.name), companies.id`,
      [actorUserId]
    );
    if (options.timing) options.timing.membershipMs = Date.now() - membershipStartedAt;
    const allCompanies = companiesResult.rows as Array<JsonObject & { id: string; role: string }>;
    const requestedCompanyId = options.companyId?.trim() ?? "";
    const companies = requestedCompanyId
      ? allCompanies.filter((company) => company.id === requestedCompanyId)
      : allCompanies;
    if (requestedCompanyId && companies.length === 0) throw new Error("company_scope_forbidden");
    const companyIds = companies.map((company) => company.id);
    const scoped = <T extends JsonObject>(column = "company_id") => companyIds.length > 0
      ? `${column}=ANY($1::text[])`
      : "FALSE";
    const params = [companyIds];
    if (options.projection === "summary") {
      return readPostgresMvpStateSummary({ database, actorUserId, companies, companyIds, timing: options.timing });
    }
    if (options.projection === "chat") {
      return readPostgresMvpStateChat({
        database,
        actorUserId,
        companyId: options.companyId,
        companies,
        companyIds,
        timing: options.timing
      });
    }
    // The initial UI only needs the durable row identity/status fields.  The
    // full metadata blobs are fetched by the full projection/detail routes;
    // including them in this fan-out made a small dashboard request transfer
    // several megabytes before the UI could even establish its readback
    // boundary.  Keep the full projection lossless while making the UI
    // projection bounded and read-only.
    const listRunColumns = options.projection === "ui"
      ? `id, company_id, automation_id, automation_version_id, name, status, objective, created_at, updated_at, execution_source, quarantined, readback_proof_id, ${UI_RUN_METADATA_COLUMN}`
      : "*";
    const listStepColumns = options.projection === "ui"
      ? "id, run_id, company_id, name, status, lane_id, started_at, completed_at"
      : "*";
    const listWorkerEventColumns = options.projection === "ui"
      ? "id, company_id, run_id, step_id, lane_id, event_type, message, created_at"
      : "*";
    // The UI list projection is a read-only summary. Avoid transferring
    // durable payloads, credentials, lease metadata, and workflow provenance
    // that are either scrubbed before rendering or fetched by a detail route.
    // The full projection remains lossless for explicit detail callers.
    const listApprovalColumns = options.projection === "ui"
      ? "approvals.id, approvals.company_id, approvals.run_id, approvals.job_id, approvals.title, approvals.status, approvals.priority, approvals.approval_group_id, approvals.action_kind, approvals.target_account_ref_id, approvals.payload_hash, approvals.policy_version, approvals.expires_at, approvals.decision_revision, approvals.created_at, approvals.decided_at"
      : "approvals.*";
    const listProofColumns = options.projection === "ui"
      ? `proofs.id, proofs.company_id, proofs.run_id, proofs.step_id, proofs.artifact_id, proofs.attempt_id, proofs.proof_type, proofs.label, proofs.uri, proofs.size_bytes, proofs.created_at, ${UI_PROOF_METADATA_COLUMN}`
      : "proofs.*";
    const listJobColumns = options.projection === "ui"
      ? "id, company_id, run_id, automation_id, automation_version_id, schedule_occurrence_id, concurrency_key, max_concurrency, kind, execution_mode, status, payload_hash, priority, max_attempts, attempt_count, available_at, heartbeat_at, last_error, created_at, updated_at"
      : "*";
    const listAttemptColumns = options.projection === "ui"
      ? "id, company_id, job_id, attempt_no, status, started_at, heartbeat_at, finished_at, error_code, created_at, updated_at"
      : "*";
    const listMemoryColumns = options.projection === "ui"
      ? "id, company_id, memory_key, kind, title, body, revision, status, archived_at, created_at, updated_at"
      : "*";
    const listWorkflowColumns = options.projection === "ui"
      ? "id, company_id, name, status, runner_status, runner_kind, schedule_json"
      : "*";
    const listFeedbackColumns = options.projection === "ui"
      ? "id, company_id, feedback_id, status, route, page_title, comment, artifact_uri, has_screenshot, screenshot_artifact_id, viewport_json, workflow_context_json, category, severity, fix_target, captured_at, created_at, payload_json"
      : "*";
    const listCheckColumns = options.projection === "ui"
      ? "id, kind, status, created_at, metadata_json"
      : "*";

    const uiProjection = options.projection === "ui";
    const dbFanoutStartedAt = Date.now();
    const [runs, approvals, proofs, automations, schedules, occurrences, jobs, attempts, steps, lanes, workerEvents, memory, feedbacks, checks, workflows, webOperationSettings, connectionRefs] = await Promise.all([
      rows(database, `SELECT ${listRunColumns} FROM runs WHERE ${scoped()} ORDER BY created_at DESC LIMIT 500`, params),
      rows(database, `SELECT ${listApprovalColumns} FROM approvals LEFT JOIN runs ON runs.id=approvals.run_id AND runs.company_id=approvals.company_id WHERE ${scoped("approvals.company_id")} AND (approvals.run_id IS NULL OR runs.id IS NOT NULL) ORDER BY approvals.created_at DESC LIMIT 500`, params),
      rows(database, `SELECT ${listProofColumns} FROM proofs JOIN runs ON runs.id=proofs.run_id AND runs.company_id=proofs.company_id WHERE ${scoped("proofs.company_id")} ORDER BY proofs.created_at DESC LIMIT 500`, params),
      rows(database, `SELECT * FROM mvp_automations WHERE ${scoped()} AND archived_at IS NULL ORDER BY updated_at DESC, id ASC`, params),
      rows(database, `SELECT * FROM mvp_automation_schedules WHERE ${scoped()} ORDER BY updated_at DESC`, params),
      uiProjection ? Promise.resolve([]) : rows(database, `SELECT * FROM durable_schedule_occurrences WHERE ${scoped()} ORDER BY scheduled_for DESC LIMIT 500`, params),
      rows(database, `SELECT ${listJobColumns} FROM durable_jobs WHERE ${scoped()} ORDER BY created_at DESC LIMIT 500`, params),
      rows(database, `SELECT ${listAttemptColumns} FROM durable_job_attempts WHERE ${scoped()} ORDER BY created_at DESC LIMIT 1000`, params),
      uiProjection ? Promise.resolve([]) : rows(database, `SELECT ${listStepColumns} FROM run_steps WHERE ${scoped()} ORDER BY started_at DESC LIMIT 500`, params),
      uiProjection ? Promise.resolve([]) : rows(database, `SELECT lanes.* FROM lanes LEFT JOIN runs ON runs.id=lanes.run_id WHERE ${scoped("runs.company_id")} ORDER BY lanes.updated_at DESC LIMIT 500`, params),
      uiProjection ? Promise.resolve([]) : rows(database, `SELECT ${listWorkerEventColumns} FROM worker_events WHERE ${scoped()} ORDER BY created_at DESC LIMIT 500`, params),
      rows(database, `SELECT ${listMemoryColumns} FROM company_memory_entries WHERE ${scoped()} AND status='active' ORDER BY memory_key ASC`, params),
      uiProjection ? Promise.resolve([]) : rows(database, `SELECT ${listFeedbackColumns} FROM mvp_feedback WHERE ${scoped()} ORDER BY created_at DESC LIMIT 500`, params),
      rows(database, `SELECT ${listCheckColumns} FROM system_checks ORDER BY created_at DESC LIMIT 20`),
      rows(database, `SELECT ${listWorkflowColumns} FROM registered_workflows WHERE company_id IS NULL OR ${scoped()} ORDER BY updated_at DESC`, params),
      rows(database, "SELECT * FROM web_operation_settings WHERE id='global' LIMIT 1"),
      rows(database, `SELECT id, company_id, platform, account_ref, status, scopes_json, expires_at, oauth_state, verification_status, last_verified_at, reconnect_requested_at, revoked_at, revision, created_at, updated_at FROM company_connection_account_refs WHERE ${scoped()} ORDER BY platform, account_ref`, params)
    ]);
    if (options.timing) options.timing.dbFanoutMs = Date.now() - dbFanoutStartedAt;

    const mappingStartedAt = Date.now();
    const connectionRefsByCompany = new Map<string, CompanyConnectionRefRecord[]>();
    for (const row of connectionRefs) {
      const companyId = String(row.company_id ?? "");
      const existing = connectionRefsByCompany.get(companyId) ?? [];
      existing.push({
        id: String(row.id ?? ""), companyId, platform: String(row.platform ?? ""), accountRef: String(row.account_ref ?? ""),
        status: String(row.status ?? ""), scopes: Array.isArray(parseJson(row.scopes_json, [])) ? (parseJson(row.scopes_json, []) as unknown[]).filter((value): value is string => typeof value === "string") : [],
        expiresAt: typeof row.expires_at === "string" ? row.expires_at : null, oauthState: String(row.oauth_state ?? "not_configured"),
        verificationStatus: String(row.verification_status ?? "unverified"), lastVerifiedAt: typeof row.last_verified_at === "string" ? row.last_verified_at : null,
        reconnectRequestedAt: typeof row.reconnect_requested_at === "string" ? row.reconnect_requested_at : null, revokedAt: typeof row.revoked_at === "string" ? row.revoked_at : null,
        revision: Number(row.revision ?? 1), createdAt: String(row.created_at ?? ""), updatedAt: String(row.updated_at ?? "")
      });
      connectionRefsByCompany.set(companyId, existing);
    }

    const publicAutomations = automations.map((row) => ({
      // Keep the UI's execution-target readback company-scoped and derived
      // from the same connection inventory used at Run admission time.
      ...(() => {
        const companyId = String(row.company_id ?? row.project_id ?? "");
        const builderSpec = parseObject(row.builder_spec_json);
        return { execution_target: resolveGmailExecutionTarget({ companyId, builderSpec }, connectionRefsByCompany.get(companyId) ?? []) };
      })(),
      id: String(row.id ?? ""),
      company_id: String(row.company_id ?? row.project_id ?? ""),
      project_id: String(row.project_id ?? row.company_id ?? ""),
      revision: Number(row.revision ?? 1),
      current_version_id: row.current_version_id ?? null,
      automation_type: String(row.automation_type ?? "sns-post"),
      name: String(row.name ?? ""),
      desc: String(row.description ?? row.desc ?? ""),
      description: String(row.description ?? row.desc ?? ""),
      goal: String(row.goal ?? ""),
      ...automationScheduleProjection(row, schedules),
      ...automationExecutionContract(row.worker_command_kind),
      lane: String(row.lane ?? "Lane 1"),
      risk_level: String(row.risk_level ?? "high"),
      approval_policy: String(row.approval_policy ?? "required_before_external_post"),
      worker_command_kind: String(row.worker_command_kind ?? "safe_local_demo"),
      create_approval: row.create_approval === 1 || row.create_approval === true,
      status: String(row.status ?? "draft"),
      builder_spec: parseJson(row.builder_spec_json),
      created_at: String(row.created_at ?? ""),
      updated_at: String(row.updated_at ?? "")
    }));
    const publicSchedules = schedules.map(publicScheduleRow);
    const dashboardListSanitizer = { compactMetadata: true } as const;
    const queueReadbackNowMs = Date.now();
    const publicJobs: JsonObject[] = sanitizeDashboardRows(jobs.map((row) => publicDurableJobRow(row, queueReadbackNowMs)), dashboardListSanitizer);
    const publicAttempts: JsonObject[] = sanitizeDashboardRows(attempts.map(publicDurableAttemptRow));
    const publicOccurrences = occurrences.map(publicScheduleOccurrenceRow);
    const publicMemory = memory.map(publicMemoryRow);
    const publicFeedbacks: JsonObject[] = sanitizeDashboardRows(feedbacks.map(publicFeedbackRow), dashboardListSanitizer);
    const sanitizedRuns = sanitizeDashboardRows(runs, dashboardListSanitizer);
    const sanitizedApprovals = sanitizeDashboardRows(approvals, dashboardListSanitizer);
    const sanitizedProofs = sanitizeDashboardRows(proofs, dashboardListSanitizer);
    const sanitizedSteps = sanitizeDashboardRows(steps, dashboardListSanitizer);
    const sanitizedLanes = sanitizeDashboardRows(lanes);
    const sanitizedWorkerEvents = sanitizeDashboardRows(workerEvents, dashboardListSanitizer);
    // The dashboard run list is intentionally bounded and ordered for the
    // general Runs surface. The five-row start guide needs a complete set of
    // candidates for the company-scoped saved/registered automation IDs so
    // its own latest-candidate logic can fail closed on a newer bad run rather
    // than falling back to an older verified one.
    const guideAutomationIds = [...new Set([
      ...publicAutomations.map((automation) => automation.id).filter(Boolean),
      ...workflows.map((workflow) => String(workflow.id ?? "").trim()).filter(Boolean)
    ])];
    const workflowStartGuideRuns = guideAutomationIds.length === 0
      ? []
      : sanitizeDashboardRows(
        await rows(database, `SELECT ${listRunColumns} FROM runs WHERE ${scoped()} AND automation_id=ANY($2::text[]) ORDER BY COALESCE(updated_at, created_at) DESC, id ASC`, [companyIds, guideAutomationIds]),
        dashboardListSanitizer
      );
    const queuedJobs = publicJobs.filter((job) => job.status === "queued");
    const queuedCurrentCount = queuedJobs.filter((job) => job.queue_freshness === "fresh").length;
    const queuedHistoricalCount = queuedJobs.filter((job) => job.queue_freshness === "historical").length;
    const queuedUnknownCount = queuedJobs.filter((job) => job.queue_freshness === "unknown").length;
    const queueNextAction = queuedHistoricalCount > 0 && queuedCurrentCount === 0
      ? "historical queued recordは現行Runとしてclaim/reuseせず、fresh idempotency/readbackで再確認してください。"
      : queuedHistoricalCount > 0
        ? `fresh queued=${queuedCurrentCount}を優先し、historical queued=${queuedHistoricalCount}はclaim/reuseしないでください。`
        : queuedUnknownCount > 0 && queuedCurrentCount === 0
          ? "queued recordの時刻を確認できないためclaimせず、fresh idempotency/readbackを確認してください。"
          : queuedJobs.length > 0 ? "登録済みservice workerのclaimを待っています。" : "待機中のjobはありません。";
    const leasedJobs = publicJobs.filter((job) => job.status === "leased");
    const latestCheck = checks.find((row) => row.id === "local_codex_worker_heartbeat" || row.kind === "local_codex_worker");
    const portableHeartbeat = selectPortableWorkerHeartbeat(checks, companyIds);
    const portableRemoteHeartbeat = portableHeartbeat?.readback ?? null;
    const portableHeartbeatAt = portableRemoteHeartbeat?.heartbeatAt
      ?? (portableHeartbeat && typeof portableHeartbeat.row.created_at === "string" ? portableHeartbeat.row.created_at : null);
    const portableHeartbeatFreshness = portableHeartbeat
      ? classifyPortableWorkerHeartbeat({
        heartbeatAt: portableHeartbeatAt,
        staleAfterSeconds: Number(process.env.AUTOMATION_OS_PORTABLE_WORKER_HEARTBEAT_STALE_SECONDS ?? 300)
      })
      : null;
    const portableHeartbeatBlocker = portableRemoteHeartbeat?.exactBlocker
      ?? portableHeartbeatFreshness?.exactBlocker
      ?? (portableHeartbeat?.row.status === "blocked" ? "portable_worker_heartbeat_blocked" : null);
    const workerStatus = latestCheck?.status === "blocked"
      ? "blocked"
      : portableHeartbeat?.row.status === "blocked"
        ? "blocked"
        : portableHeartbeat?.row.status === "running" && portableHeartbeatFreshness?.heartbeatFresh === true
          ? "running"
          : portableHeartbeat && portableHeartbeatFreshness?.heartbeatFresh === false
            ? "blocked"
        : leasedJobs.length > 0 ? "running" : "idle";
    const workerBlocker = portableRemoteHeartbeat?.exactBlocker
      ?? portableHeartbeatBlocker
      ?? (typeof latestCheck?.metadata_json === "string" ? parseObject(latestCheck.metadata_json).exactBlocker : null);
    const selectedBackend = resolveWebOperationBackend(webOperationSettings[0]?.backend);
    const selectedProfileSurface = String(webOperationSettings[0]?.chrome_surface ?? "signed_chrome_extension_profile2");
    const selectedBrowserSurface = browserSurfaceForWebOperationBackend(selectedBackend, selectedProfileSurface);
    if (options.timing) options.timing.mappingMs = Date.now() - mappingStartedAt;
    const runtimeSnapshotStartedAt = Date.now();
    const browserRuntime = await buildBrowserUseRuntimeSnapshotAsync({
      controlPlaneCompanyIds: companyIds,
      selectedBackend,
      targetScopedReadback: true,
      remoteChromePluginReadback: portableRemoteHeartbeat?.chromePluginReadback ?? null,
      remoteWorkerHeartbeat: portableRemoteHeartbeat,
    });
    if (options.timing) options.timing.runtimeSnapshotMs = Date.now() - runtimeSnapshotStartedAt;
    const workerScope = browserRuntime.processReadback.portableRemoteWorker.scopeReadback;
    const liveTransport = browserRuntime.processReadback.portableRemoteWorker.transportReadback;
    const projectedPortableHeartbeatAt = resolvePortableWorkerHeartbeatAt({
      liveLastSuccessfulHeartbeatAt: liveTransport.lastSuccessfulHeartbeatAt,
      liveHeartbeatAt: liveTransport.heartbeatAt,
      persistedHeartbeatAt: portableHeartbeatAt
    });
    const projectedPortableHeartbeatFreshness = projectedPortableHeartbeatAt
      ? classifyPortableWorkerHeartbeat({
        heartbeatAt: projectedPortableHeartbeatAt,
        staleAfterSeconds: Number(process.env.AUTOMATION_OS_PORTABLE_WORKER_HEARTBEAT_STALE_SECONDS ?? 300)
      })
      : portableHeartbeatFreshness;
    const liveTransportFileFreshness = liveTransport.source === "worker_status_file"
      && liveTransport.heartbeatStatus === "ok"
      && (liveTransport.lastSuccessfulHeartbeatAt ?? liveTransport.heartbeatAt)
      ? classifyPortableWorkerHeartbeat({
        heartbeatAt: liveTransport.lastSuccessfulHeartbeatAt ?? liveTransport.heartbeatAt,
        staleAfterSeconds: Number(process.env.AUTOMATION_OS_PORTABLE_WORKER_HEARTBEAT_STALE_SECONDS ?? 300)
      })
      : null;
    const liveHeartbeatHealthy = (liveTransport.heartbeatStatus === "ok"
      && projectedPortableHeartbeatFreshness?.heartbeatFresh === true)
      || liveTransportFileFreshness?.heartbeatFresh === true;
    // A legacy local_codex_worker(_heartbeat) system-check row can remain
    // blocked after the authenticated portable heartbeat has recovered.  The
    // full projection already treats a null/staleness-only persisted blocker
    // as superseded by a fresh live heartbeat; keep the summary projection
    // identical so Company/Runs cards do not report a stale worker blocker.
    const persistedHeartbeatBlockerOnly = (
      workerBlocker === null
      || workerBlocker === "portable_worker_heartbeat_stale"
      || workerBlocker === "portable_worker_heartbeat_blocked"
    ) && (
      projectedPortableHeartbeatFreshness?.heartbeatFresh === false
      || latestCheck?.status === "blocked"
    );
    const persistedScopeBlockerOnly = workerBlocker === "portable_worker_company_scope_unreadable"
      && liveHeartbeatHealthy
      && workerScope.status === "matched"
      && workerScope.exactBlocker === null;
    const liveHeartbeatScopeMatches = liveHeartbeatHealthy
      && Boolean(portableRemoteHeartbeat?.companyId)
      && companyIds.includes(portableRemoteHeartbeat?.companyId ?? "")
      && (workerScope.remoteWorkerCompanyIds.includes(portableRemoteHeartbeat?.companyId ?? "")
        || workerScope.exactBlocker === "portable_worker_company_scope_unreadable");
    const transientScopeReadbackBlocker = workerScope.exactBlocker === "portable_worker_company_scope_unreadable"
      && liveHeartbeatScopeMatches;
    const heartbeatRecoveryClearsBlocker = (liveHeartbeatHealthy && persistedHeartbeatBlockerOnly)
      || persistedScopeBlockerOnly
      || (liveTransport.source === "worker_status_file"
        && liveTransport.heartbeatStatus === "ok"
        && (workerBlocker === null || workerBlocker === "portable_worker_heartbeat_stale" || workerBlocker === "portable_worker_heartbeat_blocked"));
    const resolvedWorkerBlocker = heartbeatRecoveryClearsBlocker
      ? null
      : transientScopeReadbackBlocker
        ? ((liveTransport.heartbeatStatus === "blocked" ? liveTransport.heartbeatExactBlocker : null)
          ?? (typeof workerBlocker === "string" && workerBlocker !== "portable_worker_company_scope_unreadable" ? workerBlocker : null))
        : workerScope.exactBlocker
          ?? (liveTransport.heartbeatStatus === "blocked" ? liveTransport.heartbeatExactBlocker : null)
          ?? (typeof workerBlocker === "string" ? workerBlocker : null);
    // Status follows the reconciled blocker, not the historical system-check
    // row. A fresh portable heartbeat therefore clears an old heartbeat-only
    // blocked row while non-heartbeat blockers remain visible above.
    const liveTransportFreshness = liveTransport.lastSuccessfulHeartbeatAt ?? liveTransport.heartbeatAt
      ? classifyPortableWorkerHeartbeat({
        heartbeatAt: liveTransport.lastSuccessfulHeartbeatAt ?? liveTransport.heartbeatAt,
        staleAfterSeconds: Number(process.env.AUTOMATION_OS_PORTABLE_WORKER_HEARTBEAT_STALE_SECONDS ?? 300)
      })
      : null;
    const liveTransportRecoversHeartbeatBlocker = liveTransport.heartbeatStatus === "ok"
      && liveTransportFreshness?.heartbeatFresh === true
      && (workerBlocker === null
        || workerBlocker === "portable_worker_heartbeat_stale"
        || workerBlocker === "portable_worker_heartbeat_blocked");
    const resolvedWorkerStatus = liveTransportRecoversHeartbeatBlocker
      ? leasedJobs.length > 0 ? "running" : "idle"
      : resolvedWorkerBlocker
        ? "blocked"
        : leasedJobs.length > 0 ? "running" : "idle";
    const publicWorkflows = workflows.map(publicRegisteredWorkflowRow);
    const capturedAt = new Date().toISOString();
    return {
      projects: companies.map((company) => ({ id: company.id, project_id: company.id, name: company.name, status: company.status, role: company.role })),
      companies,
      automations: publicAutomations,
      presentation_profiles: companies.map((company) => publicPresentationProfile(company, publicAutomations, memory)),
      builder_specs: publicAutomations.map((automation) => ({ automation_id: automation.id, company_id: automation.company_id, project_id: automation.project_id, updated_at: automation.updated_at, spec: automation.builder_spec })),
      schedules: publicSchedules,
      runs: sanitizedRuns,
      workflowStartGuideRuns,
      jobs: publicJobs,
      job_attempts: publicAttempts,
      schedule_occurrences: publicOccurrences,
      actionableRuns: sanitizedRuns.filter((run) => ["queued", "waiting_approval", "approval_required", "blocked"].includes(String(run.status ?? ""))),
      steps: sanitizedSteps,
      lanes: sanitizedLanes,
      approvals: sanitizedApprovals,
      approvalInbox: sanitizedApprovals,
      proofs: sanitizedProofs,
      childRuns: [],
      workerEvents: sanitizedWorkerEvents,
      project_memory: publicMemory,
      feedbacks: publicFeedbacks,
      feedback_summary: {
        source: "mvp_feedback",
        captured_at: publicFeedbacks[0]?.created_at ?? capturedAt,
        count: publicFeedbacks.length,
        open_count: publicFeedbacks.filter((item) => item.status === "open").length,
        triaged_count: publicFeedbacks.filter((item) => item.status === "triaged").length
      },
      registeredWorkflows: publicWorkflows,
      registered_workflow_ids: publicWorkflows.map((workflow) => workflow.id),
      sync_readback: {
        schema: "mvp_sync_readback.v1",
        captured_at: capturedAt,
        company_ids: companyIds,
        automation_ids: publicAutomations.map((automation) => automation.id),
        registered_workflow_ids: publicWorkflows.map((workflow) => workflow.id),
        automation_count: publicAutomations.length,
        registered_workflow_count: publicWorkflows.length,
        runs_count: sanitizedRuns.length
      },
      worker: {
        id: "durable-company-queue",
        status: resolvedWorkerStatus,
        label: resolvedWorkerStatus === "blocked" ? "Mac worker要確認" : "会社別durable queue",
        detail: resolvedWorkerBlocker
          ? `Mac worker readback: ${resolvedWorkerBlocker}`
          : `queued ${queuedJobs.length} / fresh ${queuedCurrentCount} / historical ${queuedHistoricalCount} / unknown ${queuedUnknownCount} / leased ${leasedJobs.length}`,
        queue_depth: queuedJobs.length,
        queue_current_count: queuedCurrentCount,
        queue_historical_count: queuedHistoricalCount,
        queue_unknown_count: queuedUnknownCount,
        active_leases: leasedJobs.length,
        heartbeat_at: projectedPortableHeartbeatAt ?? latestCheck?.created_at ?? null,
        heartbeat_age_seconds: projectedPortableHeartbeatFreshness?.heartbeatAgeSeconds,
        heartbeat_fresh: projectedPortableHeartbeatFreshness?.heartbeatFresh,
        last_run_id: String(publicJobs[0]?.run_id ?? sanitizedRuns[0]?.id ?? "") || null,
        readback_status: projectedPortableHeartbeatFreshness?.readbackStatus ?? "stored",
        exact_blocker: resolvedWorkerBlocker,
        next_action: workerScope.exactBlocker
          ? workerScope.nextAction
          : resolvedWorkerBlocker ? "Mac workerのreadbackを確認してください。" : queueNextAction,
        queue_scope: { source: "postgres_persistent_read_pool", company_ids: companyIds },
        worker_scope: workerScope,
        portable_remote_worker: browserRuntime.processReadback.portableRemoteWorker,
        heartbeat_metadata: browserRuntime.processReadback.portableRemoteWorker.heartbeatMetadata,
        remote_report: browserRuntime.processReadback.portableRemoteWorker.remoteReport,
        external_action_executed: false
      },
      browser_use_runtime: browserRuntime,
      web_operation_backend: {
        schema: "aos_web_operation_backend_setting.v1",
        id: "global",
        backend: String(webOperationSettings[0]?.backend ?? "chrome_plugin"),
        revision: Number(webOperationSettings[0]?.revision ?? 1),
        chrome_profile: {
          id: String(webOperationSettings[0]?.chrome_profile_id ?? "profile2"),
          name: String(webOperationSettings[0]?.chrome_profile_name ?? "Profile 2"),
          directory: String(webOperationSettings[0]?.chrome_profile_directory ?? "Profile 2"),
          surface: selectedProfileSurface
        },
        browser_surface: selectedBrowserSurface,
        source: "aos_global_setting",
        updated_at: String(webOperationSettings[0]?.updated_at ?? capturedAt),
        updated_by: webOperationSettings[0]?.updated_by ?? null,
        exact_blocker: null
      },
      company_scope: { enforced: true, company_ids: companyIds, actor_user_id: actorUserId },
      updated_at: capturedAt,
      readback_source: "postgres_persistent_read_pool",
      external_action_executed: false
    };
}

function jstDayBoundsIso(nowMs = Date.now()): { start: string; end: string } {
  const jst = new Date(nowMs + 9 * 60 * 60 * 1000);
  const startUtcMs = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate()) - 9 * 60 * 60 * 1000;
  return { start: new Date(startUtcMs).toISOString(), end: new Date(startUtcMs + 24 * 60 * 60 * 1000).toISOString() };
}

async function readPostgresMvpStateSummary({
  database,
  actorUserId,
  companies,
  companyIds,
  timing
}: {
  database: PostgresMvpStateQueryClient;
  actorUserId: string;
  companies: Array<JsonObject & { id: string; role: string }>;
  companyIds: string[];
  timing?: MvpStateReadTiming;
}): Promise<JsonObject> {
  const capturedAt = new Date().toISOString();
  const day = jstDayBoundsIso();
  const scope = companyIds.length > 0 ? "runs.company_id=ANY($1::text[])" : "FALSE";
  const companyScope = companyIds.length > 0 ? "company_id=ANY($1::text[])" : "FALSE";
  const dbFanoutStartedAt = Date.now();
  const [runSummaryRows, recentRuns, approvalSummaryRows, proofSummaryRows, jobSummaryRows, queuedJobRows, automations, checks, workflows, webOperationSettings, schedules, profileMemory] = await Promise.all([
    rows(database, `SELECT
        COUNT(*)::int AS total_count,
        COUNT(*) FILTER (WHERE status IN ('blocked', 'failed', 'cancelled', 'canceled', 'timed_out', 'reconciliation_required'))::int AS blocked_count,
        COUNT(*) FILTER (WHERE status IN ('queued', 'running'))::int AS active_count,
        COUNT(*) FILTER (WHERE status IN ('complete', 'completed', 'success', 'succeeded'))::int AS completed_count,
        COUNT(*) FILTER (WHERE COALESCE(updated_at, created_at) >= $2 AND COALESCE(updated_at, created_at) < $3)::int AS today_count,
        COUNT(*) FILTER (WHERE status IN ('blocked', 'failed', 'cancelled', 'canceled', 'timed_out', 'reconciliation_required') AND COALESCE(updated_at, created_at) >= $2 AND COALESCE(updated_at, created_at) < $3)::int AS today_blocked_count,
        COUNT(*) FILTER (WHERE status IN ('queued', 'running') AND COALESCE(updated_at, created_at) >= $2 AND COALESCE(updated_at, created_at) < $3)::int AS today_active_count,
        COUNT(*) FILTER (WHERE status IN ('complete', 'completed', 'success', 'succeeded') AND COALESCE(updated_at, created_at) >= $2 AND COALESCE(updated_at, created_at) < $3)::int AS today_completed_count
      FROM runs WHERE ${scope}`, [companyIds, day.start, day.end]),
    rows(database, `SELECT id, company_id, automation_id, automation_version_id, name, status, objective, created_at, updated_at, execution_source, quarantined, readback_proof_id, metadata_json
      FROM runs WHERE ${scope} ORDER BY updated_at DESC, created_at DESC LIMIT 25`, [companyIds]),
    rows(database, `SELECT
        COUNT(*)::int AS total_count,
        COUNT(*) FILTER (WHERE status IN ('waiting', 'pending') AND (expires_at IS NULL OR expires_at > $2))::int AS waiting_count,
        COUNT(*) FILTER (WHERE status IN ('waiting', 'pending') AND expires_at IS NOT NULL AND expires_at <= $2)::int AS expired_count
      FROM approvals WHERE ${companyScope}`, [companyIds, capturedAt]),
    rows(database, `SELECT COUNT(*)::int AS total_count FROM proofs WHERE ${companyScope}`, [companyIds]),
    rows(database, `SELECT
        COUNT(*)::int AS total_count,
        COUNT(*) FILTER (WHERE status='queued')::int AS queued_count,
        COUNT(*) FILTER (WHERE status='leased')::int AS leased_count
      FROM durable_jobs WHERE ${companyScope}`, [companyIds]),
    rows(database, `SELECT status, available_at, created_at
      FROM durable_jobs WHERE ${companyScope} AND status='queued'`, [companyIds]),
    rows(database, `SELECT * FROM mvp_automations WHERE ${companyScope} AND archived_at IS NULL ORDER BY updated_at DESC, id ASC`, [companyIds]),
    rows(database, "SELECT * FROM system_checks ORDER BY created_at DESC LIMIT 20"),
    rows(database, `SELECT * FROM registered_workflows WHERE company_id IS NULL OR ${companyScope} ORDER BY updated_at DESC`, [companyIds]),
    rows(database, "SELECT * FROM web_operation_settings WHERE id='global' LIMIT 1"),
    rows(database, `SELECT * FROM mvp_automation_schedules WHERE ${companyScope} ORDER BY updated_at DESC`, [companyIds]),
    rows(database, `SELECT company_id, memory_key, body, revision FROM company_memory_entries WHERE ${companyScope} AND memory_key='project_profile' AND status='active'`, [companyIds])
  ]);
  if (timing) timing.dbFanoutMs = Date.now() - dbFanoutStartedAt;

  const mappingStartedAt = Date.now();
  const publicAutomations = automations.map((row) => ({
    id: String(row.id ?? ""),
    company_id: String(row.company_id ?? row.project_id ?? ""),
    project_id: String(row.project_id ?? row.company_id ?? ""),
    revision: Number(row.revision ?? 1),
    current_version_id: row.current_version_id ?? null,
    automation_type: String(row.automation_type ?? "sns-post"),
    name: String(row.name ?? ""),
    desc: String(row.description ?? row.desc ?? ""),
    description: String(row.description ?? row.desc ?? ""),
    goal: String(row.goal ?? ""),
    ...automationScheduleProjection(row, schedules),
    ...automationExecutionContract(row.worker_command_kind),
    lane: String(row.lane ?? "Lane 1"),
    risk_level: String(row.risk_level ?? "high"),
    approval_policy: String(row.approval_policy ?? "required_before_external_post"),
    worker_command_kind: String(row.worker_command_kind ?? "safe_local_demo"),
    create_approval: row.create_approval === 1 || row.create_approval === true,
    status: String(row.status ?? "draft"),
    builder_spec: parseJson(row.builder_spec_json),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? "")
  }));
  const sanitizedRuns = sanitizeDashboardRows(recentRuns, { compactMetadata: true });
  const runSummary = runSummaryRows[0] ?? {};
  const approvalSummary = approvalSummaryRows[0] ?? {};
  const proofSummary = proofSummaryRows[0] ?? {};
  const jobSummary = jobSummaryRows[0] ?? {};
  const queueReadbackNowMs = Date.parse(capturedAt);
  const queuedFreshness = queuedJobRows.map((row) => classifyQueuedJobFreshness({
    status: row.status,
    availableAt: row.available_at,
    createdAt: row.created_at,
    nowMs: Number.isFinite(queueReadbackNowMs) ? queueReadbackNowMs : Date.now()
  }));
  const queuedCurrentCount = queuedFreshness.filter((freshness) => freshness === "fresh").length;
  const queuedHistoricalCount = queuedFreshness.filter((freshness) => freshness === "historical").length;
  const queuedUnknownCount = queuedFreshness.filter((freshness) => freshness === "unknown").length;
  const queueNextAction = queuedHistoricalCount > 0 && queuedCurrentCount === 0
    ? "historical queued recordは現行Runとしてclaim/reuseせず、fresh idempotency/readbackで再確認してください。"
    : queuedHistoricalCount > 0
      ? `fresh queued=${queuedCurrentCount}を優先し、historical queued=${queuedHistoricalCount}はclaim/reuseしないでください。`
      : queuedUnknownCount > 0 && queuedCurrentCount === 0
        ? "queued recordの時刻を確認できないためclaimせず、fresh idempotency/readbackを確認してください。"
        : Number(jobSummary.queued_count ?? 0) > 0 ? "登録済みservice workerのclaimを待っています。" : "待機中のjobはありません。";
  const latestCheck = checks.find((row) => row.id === "local_codex_worker_heartbeat" || row.kind === "local_codex_worker");
  const portableHeartbeat = selectPortableWorkerHeartbeat(checks, companyIds);
  const portableRemoteHeartbeat = portableHeartbeat?.readback ?? null;
  const portableHeartbeatAt = portableRemoteHeartbeat?.heartbeatAt
    ?? (portableHeartbeat && typeof portableHeartbeat.row.created_at === "string" ? portableHeartbeat.row.created_at : null);
  const heartbeatFreshness = portableHeartbeat
    ? classifyPortableWorkerHeartbeat({
      heartbeatAt: portableHeartbeatAt,
      staleAfterSeconds: Number(process.env.AUTOMATION_OS_PORTABLE_WORKER_HEARTBEAT_STALE_SECONDS ?? 300)
    })
    : null;
  const workerBlocker = portableRemoteHeartbeat?.exactBlocker
    ?? (typeof latestCheck?.metadata_json === "string" ? parseObject(latestCheck.metadata_json).exactBlocker : null);
  const persistedWorkerBlocker = typeof workerBlocker === "string" ? workerBlocker : null;
  if (timing) timing.mappingMs = Date.now() - mappingStartedAt;
  // Home intentionally keeps a lightweight summary, but its worker status must
  // not be frozen to an old system_check row.  Read the canonical worker-status
  // artifact without touching process state, then keep any non-heartbeat blocker
  // authoritative.  This only reconciles the heartbeat plane; claims, receipts,
  // source sync, and external effects remain separate readbacks.
  const runtimeSnapshotStartedAt = Date.now();
  const liveProcessReadback = await buildBrowserRuntimeProcessReadbackAsync({
    controlPlaneCompanyIds: companyIds,
    readLiveProcessTable: false,
    remoteWorkerHeartbeat: portableRemoteHeartbeat
  });
  if (timing) timing.runtimeSnapshotMs = Date.now() - runtimeSnapshotStartedAt;
  const liveTransport = liveProcessReadback.portableRemoteWorker.transportReadback;
  const liveHeartbeatAt = resolvePortableWorkerHeartbeatAt({
    liveLastSuccessfulHeartbeatAt: liveTransport.lastSuccessfulHeartbeatAt,
    liveHeartbeatAt: liveTransport.heartbeatAt,
    persistedHeartbeatAt: portableHeartbeatAt
  });
  const liveHeartbeatFreshness = liveHeartbeatAt
    ? classifyPortableWorkerHeartbeat({
      heartbeatAt: liveHeartbeatAt,
      staleAfterSeconds: Number(process.env.AUTOMATION_OS_PORTABLE_WORKER_HEARTBEAT_STALE_SECONDS ?? 300)
    })
    : null;
  const liveTransportFileFreshness = liveTransport.source === "worker_status_file"
    && liveTransport.heartbeatStatus === "ok"
    && (liveTransport.lastSuccessfulHeartbeatAt ?? liveTransport.heartbeatAt)
    ? classifyPortableWorkerHeartbeat({
      heartbeatAt: liveTransport.lastSuccessfulHeartbeatAt ?? liveTransport.heartbeatAt,
      staleAfterSeconds: Number(process.env.AUTOMATION_OS_PORTABLE_WORKER_HEARTBEAT_STALE_SECONDS ?? 300)
    })
    : null;
  const liveHeartbeatHealthy = (liveTransport.heartbeatStatus === "ok"
    && liveHeartbeatFreshness?.heartbeatFresh === true)
    || liveTransportFileFreshness?.heartbeatFresh === true;
  const persistedHeartbeatBlockerOnly = (
    persistedWorkerBlocker === null
      || persistedWorkerBlocker === "portable_worker_heartbeat_stale"
      || persistedWorkerBlocker === "portable_worker_heartbeat_blocked"
  ) && (heartbeatFreshness?.heartbeatFresh === false || latestCheck?.status === "blocked");
  const persistedScopeBlockerOnly = persistedWorkerBlocker === "portable_worker_company_scope_unreadable"
    && liveHeartbeatHealthy
    && liveProcessReadback.portableRemoteWorker.scopeReadback.status === "matched"
    && liveProcessReadback.portableRemoteWorker.scopeReadback.exactBlocker === null;
  const liveHeartbeatScopeMatches = liveHeartbeatHealthy
    && Boolean(portableRemoteHeartbeat?.companyId)
    && companyIds.includes(portableRemoteHeartbeat?.companyId ?? "")
    && (liveProcessReadback.portableRemoteWorker.scopeReadback.remoteWorkerCompanyIds.includes(portableRemoteHeartbeat?.companyId ?? "")
      || liveProcessReadback.portableRemoteWorker.scopeReadback.exactBlocker === "portable_worker_company_scope_unreadable");
  const transientScopeReadbackBlocker = liveProcessReadback.portableRemoteWorker.scopeReadback.exactBlocker === "portable_worker_company_scope_unreadable"
    && liveHeartbeatScopeMatches;
  const heartbeatRecoveryClearsBlocker = (liveHeartbeatHealthy && persistedHeartbeatBlockerOnly)
    || persistedScopeBlockerOnly
    || (liveTransport.source === "worker_status_file"
      && liveTransport.heartbeatStatus === "ok"
      && (persistedWorkerBlocker === null || persistedWorkerBlocker === "portable_worker_heartbeat_stale" || persistedWorkerBlocker === "portable_worker_heartbeat_blocked"));
  const resolvedWorkerBlocker = heartbeatRecoveryClearsBlocker
    ? null
    : persistedWorkerBlocker;
  const queuedCount = Number(jobSummary.queued_count ?? 0);
  const leasedCount = Number(jobSummary.leased_count ?? 0);
  // A fresh worker-status artifact is a live readback of the heartbeat plane.
  // Do not let the older persisted check keep the summary blocked after that
  // same-run readback has proved the heartbeat fresh.
  const effectiveHeartbeatFreshness = liveHeartbeatFreshness ?? heartbeatFreshness;
  const persistedWorkerStatus = resolvedWorkerBlocker !== null || effectiveHeartbeatFreshness?.heartbeatFresh === false
    ? "blocked"
    : leasedCount > 0 || queuedCurrentCount > 0 ? "running" : "idle";
  const workerStatus = persistedWorkerStatus;
  const resolvedHeartbeatFreshness = liveHeartbeatFreshness ?? heartbeatFreshness;
  const resolvedHeartbeatAt = liveHeartbeatAt ?? portableHeartbeatAt ?? latestCheck?.created_at ?? null;
  const resolvedReadbackStatus = resolvedHeartbeatFreshness?.readbackStatus ?? "summary";
  const liveWorkerReadback = {
    source: liveTransport.source,
    status: liveTransport.status,
    heartbeat_status: liveTransport.heartbeatStatus,
    heartbeat_at: liveTransport.heartbeatAt,
    last_successful_heartbeat_at: liveTransport.lastSuccessfulHeartbeatAt,
    claim_status: liveTransport.claimStatus,
    remote_origin: liveTransport.remoteOrigin,
    worker_instance_id: liveTransport.workerInstanceId,
    generation: liveTransport.generation,
    observed_at: liveTransport.observedAt,
    identity_status: liveTransport.identityStatus,
    exact_blocker: liveTransport.heartbeatExactBlocker
  };
  const selectedSetting = webOperationSettings[0] ?? {};
  const backend = resolveWebOperationBackend(selectedSetting.backend);
  const profileSurface = String(selectedSetting.chrome_surface ?? "signed_chrome_extension_profile2");
  const surface = browserSurfaceForWebOperationBackend(backend, profileSurface);
  const publicWorkflows = workflows.map(publicRegisteredWorkflowRow);
  return {
    projects: companies.map((company) => ({ id: company.id, project_id: company.id, name: company.name, status: company.status, role: company.role })),
    companies,
    automations: publicAutomations,
    presentation_profiles: companies.map((company) => publicPresentationProfile(company, publicAutomations, profileMemory)),
    builder_specs: publicAutomations.map((automation) => ({ automation_id: automation.id, company_id: automation.company_id, project_id: automation.project_id, updated_at: automation.updated_at, spec: automation.builder_spec })),
    schedules: schedules.map(publicScheduleRow),
    runs: sanitizedRuns,
    jobs: [],
    job_attempts: [],
    schedule_occurrences: [],
    actionableRuns: [],
    steps: [],
    lanes: [],
    approvals: [],
    approvalInbox: [],
    proofs: [],
    childRuns: [],
    workerEvents: [],
    project_memory: [],
    feedbacks: [],
    feedback_summary: { source: "summary_projection", captured_at: capturedAt, count: 0, open_count: 0, triaged_count: 0 },
    registeredWorkflows: [],
    registered_workflow_ids: publicWorkflows.map((workflow) => workflow.id),
    run_summary: {
      total_count: Number(runSummary.total_count ?? 0),
      blocked_count: Number(runSummary.blocked_count ?? 0),
      active_count: Number(runSummary.active_count ?? 0),
      completed_count: Number(runSummary.completed_count ?? 0),
      today_count: Number(runSummary.today_count ?? 0),
      today_blocked_count: Number(runSummary.today_blocked_count ?? 0),
      today_active_count: Number(runSummary.today_active_count ?? 0),
      today_completed_count: Number(runSummary.today_completed_count ?? 0)
    },
    approval_summary: {
      total_count: Number(approvalSummary.total_count ?? 0),
      waiting_count: Number(approvalSummary.waiting_count ?? 0),
      expired_count: Number(approvalSummary.expired_count ?? 0)
    },
    proof_summary: { total_count: Number(proofSummary.total_count ?? 0) },
    job_summary: {
      total_count: Number(jobSummary.total_count ?? 0),
      queued_count: queuedCount,
      leased_count: leasedCount,
      queued_current_count: queuedCurrentCount,
      queued_historical_count: queuedHistoricalCount,
      queued_unknown_count: queuedUnknownCount
    },
    sync_readback: {
      schema: "mvp_sync_readback.v1",
      captured_at: capturedAt,
      company_ids: companyIds,
      automation_ids: publicAutomations.map((automation) => automation.id),
      registered_workflow_ids: publicWorkflows.map((workflow) => workflow.id),
      automation_count: publicAutomations.length,
      registered_workflow_count: publicWorkflows.length,
      runs_count: Number(runSummary.total_count ?? 0)
    },
    worker: {
      id: "durable-company-queue",
      status: workerStatus,
      label: workerStatus === "blocked" ? "Mac worker要確認" : "会社別durable queue",
      detail: resolvedWorkerBlocker ? `Mac worker readback: ${resolvedWorkerBlocker}` : `queued ${queuedCount} / fresh ${queuedCurrentCount} / historical ${queuedHistoricalCount} / unknown ${queuedUnknownCount} / leased ${leasedCount}`,
      queue_depth: queuedCount,
      queue_current_count: queuedCurrentCount,
      queue_historical_count: queuedHistoricalCount,
      queue_unknown_count: queuedUnknownCount,
      active_leases: leasedCount,
      heartbeat_at: resolvedHeartbeatAt,
      heartbeat_age_seconds: resolvedHeartbeatFreshness?.heartbeatAgeSeconds,
      heartbeat_fresh: resolvedHeartbeatFreshness?.heartbeatFresh,
      last_run_id: String(sanitizedRuns[0]?.id ?? "") || null,
      readback_status: resolvedReadbackStatus,
      exact_blocker: resolvedWorkerBlocker,
      next_action: resolvedWorkerBlocker
        ? "Mac workerのreadbackを確認してください。"
        : queueNextAction,
      live_readback: liveWorkerReadback,
      heartbeat_metadata: portableRemoteHeartbeat,
      remote_report: portableRemoteHeartbeat,
      queue_scope: { source: "postgres_persistent_read_pool", company_ids: companyIds },
      external_action_executed: false
    },
    browser_use_runtime: {
      backend,
      surface,
      helper: backend === "chrome_plugin" ? "chrome_extension_trusted_bridge" : backend,
      runtimeRole: "control_plane",
      status: "summary",
      exactBlocker: null,
      readbackStatus: "summary",
      summary: "Homeは軽量summaryです。Chat・実行履歴・承認で詳細readbackを取得します。",
      nextAction: "詳細画面を開くと、選択中backendのfresh runtime readbackを確認します。",
      fallbackPolicy: "no_implicit_surface_switch",
      contract: ["read_only", "summary_projection", "external_action_executed=false"]
    },
    web_operation_backend: {
      schema: "aos_web_operation_backend_setting.v1",
      id: "global",
      backend,
      revision: Number(selectedSetting.revision ?? 1),
      chrome_profile: {
        id: String(selectedSetting.chrome_profile_id ?? "profile2"),
        name: String(selectedSetting.chrome_profile_name ?? "Profile 2"),
        directory: String(selectedSetting.chrome_profile_directory ?? "Profile 2"),
        surface: profileSurface
      },
      browser_surface: surface,
      source: "aos_global_setting",
      updated_at: String(selectedSetting.updated_at ?? capturedAt),
      updated_by: selectedSetting.updated_by ?? null,
      exact_blocker: null
    },
    company_scope: { enforced: true, company_ids: companyIds, actor_user_id: actorUserId },
    updated_at: capturedAt,
    readback_source: "postgres_persistent_read_pool",
    readback_projection: "summary",
    readback_omitted_fields: ["full_run_history", "approvals", "proofs", "jobs", "schedules", "memory", "feedbacks", "browser_runtime_detail"],
    external_action_executed: false
  };
}

async function readPostgresMvpStateChat({
  database,
  actorUserId,
  companyId,
  companies,
  companyIds,
  timing
}: {
  database: PostgresMvpStateQueryClient;
  actorUserId: string;
  companyId?: string;
  companies: Array<JsonObject & { id: string; role: string }>;
  companyIds: string[];
  timing?: MvpStateReadTiming;
}): Promise<JsonObject> {
  // The Chat route is entered immediately after the UI has rendered the
  // summary projection. Reuse that bounded cache/in-flight read instead of
  // running the entire summary fan-out again under the separate Chat key.
  // This keeps the detail readback scoped to schedules while preserving the
  // same exact company/actor boundary.
  const fanoutStartedAt = Date.now();
  const [summary, schedules] = await Promise.all([
    readPostgresMvpState({
      actorUserId,
      companyId,
      queryClient: database,
      projection: "summary"
    }),
    rows(
      database,
      companyIds.length > 0
        ? "SELECT * FROM mvp_automation_schedules WHERE company_id=ANY($1::text[]) ORDER BY updated_at DESC"
        : "SELECT * FROM mvp_automation_schedules WHERE FALSE",
      [companyIds]
    )
  ]);
  if (timing) timing.dbFanoutMs = Date.now() - fanoutStartedAt;
  const mappingStartedAt = Date.now();
  const projected = projectMvpStateForChat({
    ...summary,
    schedules: schedules.map(publicScheduleRow),
    readback_omitted_fields: [
      "full_run_history",
      "approvals",
      "proofs",
      "jobs",
      "memory",
      "feedbacks",
      "browser_runtime_detail"
    ]
  });
  if (timing) timing.mappingMs = Date.now() - mappingStartedAt;
  return projected;
}

async function rows(client: PostgresMvpStateQueryClient, text: string, values: unknown[] = []): Promise<JsonObject[]> {
  const result = await client.query(text, values);
  return result.rows as JsonObject[];
}

function timedQueryClient(client: PostgresMvpStateQueryClient, timing?: MvpStateReadTiming): PostgresMvpStateQueryClient {
  if (!timing) return client;
  timing.queryCount = 0;
  timing.queryTimings = [];
  return {
    async query(text, values = []) {
      const startedAt = Date.now();
      const label = sqlQueryLabel(text);
      try {
        const result = await client.query(text, values);
        timing.queryCount = (timing.queryCount ?? 0) + 1;
        timing.queryTimings!.push({ label, durationMs: Date.now() - startedAt, rowCount: result.rows.length, status: "ok" });
        return result;
      } catch (error) {
        timing.queryCount = (timing.queryCount ?? 0) + 1;
        timing.queryTimings!.push({ label, durationMs: Date.now() - startedAt, rowCount: 0, status: "error" });
        throw error;
      }
    }
  };
}

function sqlQueryLabel(text: string): string {
  const match = text.match(/\bFROM\s+([A-Za-z0-9_.]+)/iu);
  const label = match?.[1]?.replace(/^.*\./u, "") ?? "query";
  return label.replace(/[^A-Za-z0-9_]/gu, "_").slice(0, 48) || "query";
}

function selectPortableWorkerHeartbeat(checks: JsonObject[], companyIds: string[]): {
  row: JsonObject;
  metadata: JsonObject;
  readback: PortableRemoteWorkerHeartbeatReadback | null;
} | null {
  const selected = checks
    .filter((row) => row.kind === "portable_mac_worker")
    .map((row) => ({ row, metadata: parseObject(row.metadata_json) }))
    .filter(({ metadata }) => {
      const companyId = typeof metadata.company_id === "string" ? metadata.company_id.trim() : "";
      return Boolean(companyId) && companyIds.includes(companyId);
    })
    .sort((left, right) => String(right.row.created_at ?? "").localeCompare(String(left.row.created_at ?? "")))
    .at(0);
  if (!selected) return null;
  const companyId = typeof selected.metadata.company_id === "string" ? selected.metadata.company_id.trim() : null;
  const readback = sanitizePortableRemoteWorkerHeartbeat(selected.metadata, {
    fallbackCompanyId: companyId,
    fallbackHeartbeatAt: typeof selected.row.created_at === "string" ? selected.row.created_at : null
  });
  // Older control-plane rows only stored the scoped company and timestamp.
  // Keep those rows available for freshness/blocker reconciliation, but do
  // not project them as a modern remote-worker identity readback. Explicitly
  // schema-tagged or identity-bearing payloads still remain unreadable when
  // sanitization rejects them.
  const legacyPartialKeys = new Set(["company_id", "companyId", "heartbeat_at", "heartbeatAt", "exact_blocker", "exactBlocker"]);
  const isLegacyPartial = Object.keys(selected.metadata).every((key) => legacyPartialKeys.has(key))
    && !Object.prototype.hasOwnProperty.call(selected.metadata, "schema")
    && !Object.prototype.hasOwnProperty.call(selected.metadata, "status");
  return { ...selected, readback: isLegacyPartial ? null : readback };
}

function automationScheduleProjection(automation: JsonObject, schedules: JsonObject[]) {
  const schedule = schedules.find((row) => row.automation_id === automation.id && row.company_id === automation.company_id);
  return {
    schedule: String(schedule?.expression ?? schedule?.kind ?? "manual"),
    cadence: String(schedule?.kind ?? "manual"),
    schedule_id: schedule?.id ?? null,
    schedule_status: schedule?.status ?? null,
    schedule_enabled: schedule?.enabled === true || schedule?.enabled === 1,
    schedule_revision: schedule ? Number(schedule.revision ?? 1) : null,
    schedule_timezone: schedule?.timezone ?? null,
    schedule_paused_at: schedule?.paused_at ?? null,
    pinned_schedule_version_id: schedule?.automation_version_id ?? null,
    next_run_at: schedule?.next_run_at ?? null,
    last_run_at: schedule?.last_run_at ?? null
  };
}

function publicScheduleRow(row: JsonObject): JsonObject {
  return {
    id: row.id,
    company_id: row.company_id,
    project_id: row.project_id ?? row.company_id,
    automation_id: row.automation_id,
    automation_version_id: row.automation_version_id ?? null,
    kind: row.kind ?? null,
    expression: row.expression ?? null,
    timezone: row.timezone ?? "UTC",
    enabled: row.enabled === 1 || row.enabled === true,
    status: row.status ?? null,
    revision: Number(row.revision ?? 1),
    next_run_at: row.next_run_at ?? null,
    last_run_at: row.last_run_at ?? null,
    paused_at: row.paused_at ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null
  };
}

function publicDurableJobRow(row: JsonObject, nowMs = Date.now()): JsonObject {
  const status = String(row.status ?? "");
  return {
    id: row.id,
    company_id: row.company_id,
    project_id: row.company_id,
    run_id: row.run_id ?? null,
    automation_id: row.automation_id ?? null,
    automation_version_id: row.automation_version_id ?? null,
    schedule_occurrence_id: row.schedule_occurrence_id ?? null,
    kind: row.kind ?? null,
    execution_mode: row.execution_mode === "external" ? "external" : "dry_run",
    status: row.status ?? null,
    queue_freshness: classifyQueuedJobFreshness({
      status,
      availableAt: row.available_at,
      createdAt: row.created_at,
      nowMs
    }),
    payload_hash: row.payload_hash ?? null,
    priority: Number(row.priority ?? 0),
    max_attempts: Number(row.max_attempts ?? 0),
    attempt_count: Number(row.attempt_count ?? 0),
    available_at: row.available_at ?? null,
    concurrency_key: row.concurrency_key ?? null,
    max_concurrency: Number(row.max_concurrency ?? 1),
    lease_active: status === "leased" && Boolean(row.lease_expires_at),
    heartbeat_at: row.heartbeat_at ?? null,
    last_error: row.last_error ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null
  };
}

function publicDurableAttemptRow(row: JsonObject): JsonObject {
  return {
    id: row.id,
    company_id: row.company_id,
    project_id: row.company_id,
    job_id: row.job_id,
    attempt_no: Number(row.attempt_no ?? 0),
    status: row.status ?? null,
    started_at: row.started_at ?? null,
    heartbeat_at: row.heartbeat_at ?? null,
    finished_at: row.finished_at ?? null,
    error: row.error_code ?? null
  };
}

function publicScheduleOccurrenceRow(row: JsonObject): JsonObject {
  return {
    id: row.id,
    company_id: row.company_id,
    project_id: row.company_id,
    schedule_id: row.schedule_id,
    occurrence_key: row.occurrence_key,
    scheduled_for: row.scheduled_for,
    status: row.status,
    job_id: row.job_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function publicPresentationProfile(company: JsonObject, automations: JsonObject[], memory: JsonObject[]): JsonObject {
  const companyId = String(company.id ?? "");
  const saved = memory.find((row) => row.company_id === companyId && row.memory_key === "project_profile");
  const profile = restoreProjectPresentationProfile(buildProjectPresentationProfile({ id: companyId,
    name: String(company.name ?? ""), automations: automations.filter((row) => row.company_id === companyId) }),
  saved ? { body: String(saved.body ?? ""), revision: Number(saved.revision) } : undefined);
  return { ...profile, company_id: companyId, project_id: companyId };
}

function publicMemoryRow(row: JsonObject): JsonObject {
  return {
    id: row.id,
    company_id: row.company_id,
    project_id: row.company_id,
    memory_key: row.memory_key,
    kind: row.kind,
    title: row.title,
    body: row.body,
    revision: Number(row.revision ?? 1),
    status: row.status,
    archived_at: row.archived_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function publicFeedbackRow(row: JsonObject): JsonObject {
  const workflowContext = parseObject(row.workflow_context_json);
  const payload = parseObject(row.payload_json);
  return {
    id: row.id,
    company_id: row.company_id,
    project_id: row.company_id,
    feedback_id: row.feedback_id,
    status: row.status,
    route: row.route,
    page_title: row.page_title,
    comment: row.comment,
    artifact_uri: row.artifact_uri,
    has_screenshot: row.has_screenshot === 1 || row.has_screenshot === true,
    screenshot_artifact_id: row.screenshot_artifact_id ?? null,
    viewport: publicViewport(parseObject(row.viewport_json)),
    workflow_context: publicProjectContext(workflowContext),
    category: row.category,
    severity: row.severity,
    fix_target: row.fix_target,
    captured_at: row.captured_at,
    created_at: row.created_at,
    payload: publicFeedbackPayload(payload)
  };
}

function publicProjectContext(value: JsonObject): JsonObject {
  return typeof value.project_id === "string" ? { project_id: value.project_id } : {};
}

function publicFeedbackPayload(value: JsonObject): JsonObject {
  return {
    ...(typeof value.project_id === "string" ? { project_id: value.project_id } : {}),
    ...(typeof value.comment === "string" ? { comment: value.comment } : {})
  };
}

function publicViewport(value: JsonObject): JsonObject {
  return {
    ...(typeof value.width === "number" ? { width: value.width } : {}),
    ...(typeof value.height === "number" ? { height: value.height } : {}),
    ...(typeof value.devicePixelRatio === "number" ? { devicePixelRatio: value.devicePixelRatio } : {})
  };
}

function publicRegisteredWorkflowRow(row: JsonObject): JsonObject {
  const schedule = parseObject(row.schedule_json);
  const workflowId = String(row.id ?? "");
  const browserUseLane = publicBrowserUseLaneBinding(registeredBrowserLaneForWorkflow(workflowId));
  return {
    id: workflowId,
    company_id: row.company_id ?? null,
    name: row.name,
    title: row.name,
    status: row.status,
    runnerStatus: row.runner_status,
    runnerKind: row.runner_kind,
    ...(browserUseLane ? { browser_use_lane: browserUseLane } : {}),
    schedule: {
      ...(typeof schedule.rrule === "string" ? { rrule: schedule.rrule } : {}),
      ...(typeof schedule.label === "string" ? { label: schedule.label } : {})
    }
  };
}

function parseJson(value: unknown, fallback: JsonObject | unknown[] = {}): JsonObject | unknown[] {
  if (typeof value !== "string") return value && typeof value === "object" ? value as JsonObject : fallback;
  try {
    return JSON.parse(value) as JsonObject | unknown[];
  } catch {
    return fallback;
  }
}

function parseObject(value: unknown): JsonObject {
  const parsed = parseJson(value);
  return !Array.isArray(parsed) && parsed && typeof parsed === "object" ? parsed : {};
}

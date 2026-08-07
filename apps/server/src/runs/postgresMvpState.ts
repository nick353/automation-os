import pg from "pg";
import { sanitizeDashboardRows } from "../dashboardSanitizer.js";
import { buildBrowserUseRuntimeSnapshot } from "../browser/runtimeSnapshot.js";

type JsonObject = Record<string, unknown>;

export type PostgresMvpStateOptions = {
  companyId?: string;
  actorUserId?: string;
  queryClient?: PostgresMvpStateQueryClient;
};

export type PostgresMvpStateQueryClient = {
  query(text: string, values?: unknown[]): Promise<{ rows: JsonObject[] }>;
};

let pool: pg.Pool | undefined;
let warmupPromise: Promise<void> | undefined;
const stateCache = new Map<string, { state: JsonObject; expiresAt: number }>();
const stateInFlight = new Map<string, Promise<JsonObject>>();
const STATE_CACHE_TTL_MS = 5_000;

function getPool(): pg.Pool {
  if (pool) return pool;
  const databaseUrl = process.env.AUTOMATION_OS_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("postgres_database_url_missing");
  pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 4,
    idleTimeoutMillis: 300_000,
    connectionTimeoutMillis: 15_000,
    query_timeout: 15_000,
    statement_timeout: 15_000,
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

export async function readPostgresMvpState(options: PostgresMvpStateOptions = {}): Promise<JsonObject> {
  const actorUserId = options.actorUserId?.trim() || process.env.AUTOMATION_OS_OWNER_USER_ID?.trim() || "user_local_owner";
  const cacheKey = `${actorUserId}\n${options.companyId?.trim() ?? ""}`;
  const now = Date.now();
  const cached = stateCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return {
      ...cached.state,
      readback_cache: {
        status: "cached",
        captured_at: cached.state.updated_at,
        max_age_ms: STATE_CACHE_TTL_MS
      }
    };
  }
  const running = stateInFlight.get(cacheKey);
  if (running) return running;
  const promise = readPostgresMvpStateUncached({ ...options, actorUserId })
    .then((state) => {
      stateCache.set(cacheKey, { state, expiresAt: Date.now() + STATE_CACHE_TTL_MS });
      return { ...state, readback_cache: { status: "fresh", captured_at: state.updated_at, max_age_ms: STATE_CACHE_TTL_MS } };
    })
    .finally(() => {
      stateInFlight.delete(cacheKey);
    });
  stateInFlight.set(cacheKey, promise);
  return promise;
}

async function readPostgresMvpStateUncached(options: PostgresMvpStateOptions = {}): Promise<JsonObject> {
    const database: PostgresMvpStateQueryClient = options.queryClient ?? getPool() as unknown as PostgresMvpStateQueryClient;
    const actorUserId = options.actorUserId?.trim() || process.env.AUTOMATION_OS_OWNER_USER_ID?.trim() || "user_local_owner";
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

    const [runs, approvals, proofs, automations, schedules, occurrences, jobs, attempts, steps, lanes, workerEvents, memory, feedbacks, checks, workflows] = await Promise.all([
      rows(database, `SELECT * FROM runs WHERE ${scoped()} ORDER BY created_at DESC LIMIT 500`, params),
      rows(database, `SELECT approvals.* FROM approvals LEFT JOIN runs ON runs.id=approvals.run_id AND runs.company_id=approvals.company_id WHERE ${scoped("approvals.company_id")} AND (approvals.run_id IS NULL OR runs.id IS NOT NULL) ORDER BY approvals.created_at DESC LIMIT 500`, params),
      rows(database, `SELECT proofs.* FROM proofs JOIN runs ON runs.id=proofs.run_id AND runs.company_id=proofs.company_id WHERE ${scoped("proofs.company_id")} ORDER BY proofs.created_at DESC LIMIT 500`, params),
      rows(database, `SELECT * FROM mvp_automations WHERE ${scoped()} AND archived_at IS NULL ORDER BY updated_at DESC, id ASC`, params),
      rows(database, `SELECT * FROM mvp_automation_schedules WHERE ${scoped()} ORDER BY updated_at DESC`, params),
      rows(database, `SELECT * FROM durable_schedule_occurrences WHERE ${scoped()} ORDER BY scheduled_for DESC LIMIT 500`, params),
      rows(database, `SELECT * FROM durable_jobs WHERE ${scoped()} ORDER BY created_at DESC LIMIT 500`, params),
      rows(database, `SELECT * FROM durable_job_attempts WHERE ${scoped()} ORDER BY created_at DESC LIMIT 1000`, params),
      rows(database, `SELECT * FROM run_steps WHERE ${scoped()} ORDER BY started_at DESC LIMIT 500`, params),
      rows(database, `SELECT lanes.* FROM lanes LEFT JOIN runs ON runs.id=lanes.run_id WHERE ${scoped("runs.company_id")} ORDER BY lanes.updated_at DESC LIMIT 500`, params),
      rows(database, `SELECT * FROM worker_events WHERE ${scoped()} ORDER BY created_at DESC LIMIT 500`, params),
      rows(database, `SELECT * FROM company_memory_entries WHERE ${scoped()} AND status='active' ORDER BY memory_key ASC`, params),
      rows(database, `SELECT * FROM mvp_feedback WHERE ${scoped()} ORDER BY created_at DESC LIMIT 500`, params),
      rows(database, "SELECT * FROM system_checks ORDER BY created_at DESC LIMIT 20"),
      rows(database, `SELECT * FROM registered_workflows WHERE company_id IS NULL OR ${scoped()} ORDER BY updated_at DESC`, params)
    ]);

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
      schedule: String(row.schedule ?? "09:00"),
      cadence: String(row.cadence ?? "daily"),
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
    const publicJobs: JsonObject[] = sanitizeDashboardRows(jobs.map(publicDurableJobRow));
    const publicAttempts: JsonObject[] = sanitizeDashboardRows(attempts.map(publicDurableAttemptRow));
    const publicOccurrences = occurrences.map(publicScheduleOccurrenceRow);
    const publicMemory = memory.map(publicMemoryRow);
    const publicFeedbacks: JsonObject[] = sanitizeDashboardRows(feedbacks.map(publicFeedbackRow));
    const sanitizedRuns = sanitizeDashboardRows(runs);
    const sanitizedApprovals = sanitizeDashboardRows(approvals);
    const sanitizedProofs = sanitizeDashboardRows(proofs);
    const sanitizedSteps = sanitizeDashboardRows(steps);
    const sanitizedLanes = sanitizeDashboardRows(lanes);
    const sanitizedWorkerEvents = sanitizeDashboardRows(workerEvents);
    const queuedJobs = publicJobs.filter((job) => job.status === "queued");
    const leasedJobs = publicJobs.filter((job) => job.status === "leased");
    const latestCheck = checks.find((row) => row.id === "local_codex_worker_heartbeat" || row.kind === "local_codex_worker");
    const workerStatus = latestCheck?.status === "blocked" ? "blocked" : leasedJobs.length > 0 ? "running" : "idle";
    const workerBlocker = typeof latestCheck?.metadata_json === "string" ? parseObject(latestCheck.metadata_json).exactBlocker : null;
    const publicWorkflows = workflows.map(publicRegisteredWorkflowRow);
    const capturedAt = new Date().toISOString();
    return {
      projects: companies.map((company) => ({ id: company.id, project_id: company.id, name: company.name, status: company.status, role: company.role })),
      companies,
      automations: publicAutomations,
      presentation_profiles: companies.map((company) => ({ company_id: company.id, project_id: company.id, source: "postgres_readback" })),
      builder_specs: publicAutomations.map((automation) => ({ automation_id: automation.id, company_id: automation.company_id, project_id: automation.project_id, updated_at: automation.updated_at, spec: automation.builder_spec })),
      schedules: publicSchedules,
      runs: sanitizedRuns,
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
        status: workerStatus,
        label: workerStatus === "blocked" ? "Mac worker要確認" : "会社別durable queue",
        detail: workerBlocker ? `Mac worker readback: ${workerBlocker}` : `queued ${queuedJobs.length} / leased ${leasedJobs.length}`,
        queue_depth: queuedJobs.length,
        active_leases: leasedJobs.length,
        heartbeat_at: latestCheck?.created_at ?? null,
        last_run_id: String(publicJobs[0]?.run_id ?? sanitizedRuns[0]?.id ?? "") || null,
        readback_status: "stored",
        exact_blocker: typeof workerBlocker === "string" ? workerBlocker : null,
        next_action: workerBlocker ? "Mac workerのreadbackを確認してください。" : queuedJobs.length > 0 ? "登録済みservice workerのclaimを待っています。" : "待機中のjobはありません。",
        external_action_executed: false
      },
      browser_use_runtime: buildBrowserUseRuntimeSnapshot(),
      company_scope: { enforced: true, company_ids: companyIds, actor_user_id: actorUserId },
      updated_at: capturedAt,
      readback_source: "postgres_persistent_read_pool",
      external_action_executed: false
    };
}

async function rows(client: PostgresMvpStateQueryClient, text: string, values: unknown[] = []): Promise<JsonObject[]> {
  const result = await client.query(text, values);
  return result.rows as JsonObject[];
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

function publicDurableJobRow(row: JsonObject): JsonObject {
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
  return {
    id: row.id,
    company_id: row.company_id ?? null,
    name: row.name,
    title: row.name,
    status: row.status,
    runnerStatus: row.runner_status,
    runnerKind: row.runner_kind,
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

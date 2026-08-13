import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { evaluateServerStartupPolicy } from "../cli/serverStartupPolicy.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(moduleDir, "schema.sql");
const startupPolicy = evaluateServerStartupPolicy(process.env);
if (!startupPolicy.ok) {
  // Keep the backend boundary fail-closed even when a caller launches the
  // server or a CLI directly without going through serverStartupGuard.
  throw new Error(startupPolicy.exactBlocker);
}
const defaultDbPath = resolve(process.cwd(), "data", "automation-os.sqlite");
const postgresUrl = process.env.AUTOMATION_OS_DATABASE_URL ?? process.env.DATABASE_URL ?? process.env.POSTGRES_URI;
const postgresWorkerTimeoutMs = Number(process.env.AUTOMATION_OS_POSTGRES_WORKER_TIMEOUT_MS ?? 12000);
// Read-only child processes are spawned by an already-started server. The
// parent has already passed the database startup/bootstrap boundary, so
// repeating the remote schema probe in every child only adds latency. The
// flag is set by those read-only child launchers, never by public requests.
const postgresSchemaAssumedCurrent = process.env.AUTOMATION_OS_POSTGRES_SCHEMA_ASSUMED_CURRENT === "1";
// Bump when an idempotent migration adds a durable schema object that must be
// applied to already-bootstrapped PostgreSQL databases.
export const postgresSchemaBootstrapVersion = 8;

export const dbPath = process.env.AUTOMATION_OS_DB ?? defaultDbPath;
export const dbBackend = postgresUrl ? "postgres" : "sqlite";

export type SqlValue = string | number | boolean | null | undefined | object | unknown[];
export type SqlTransactionStep = {
  sql: string;
  expectChanges?: number;
};

let dbInitialized = false;
let dbInitializing = false;
let dbInitRunCount = 0;
let dbConnection: Database.Database | undefined;
let postgresAsyncPool: pg.Pool | undefined;

export function sqlValue(value: SqlValue): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `'${text.replaceAll("'", "''")}'`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function execSql(sql: string): void {
  if (dbBackend === "postgres") {
    execPostgresSql(sql);
  } else {
    mkdirSync(dirname(dbPath), { recursive: true });
    getDb().exec(sql);
  }
  if (!dbInitializing && affectsSchema(sql)) {
    dbInitialized = false;
  }
}

export function querySql<T = Record<string, unknown>>(sql: string): T[] {
  initDb();
  if (dbBackend === "postgres") {
    return queryPostgresSql(sql) as T[];
  }
  return getDb().prepare(sql).all() as T[];
}

export function querySqlBatch(sqls: string[]): Array<Array<Record<string, unknown>>> {
  initDb();
  if (dbBackend === "postgres") {
    return queryPostgresSqlBatch(sqls);
  }
  return sqls.map((sql) => getDb().prepare(sql).all() as Array<Record<string, unknown>>);
}

export function runSqlTransaction(steps: readonly SqlTransactionStep[]): void {
  initDb();
  if (steps.length === 0) return;
  if (dbBackend === "postgres") {
    runPostgresWorkerTransaction(steps.map((step) => ({
      ...step,
      sql: translateSqlForPostgres(step.sql)
    })));
    return;
  }
  const transaction = getDb().transaction(() => {
    for (const step of steps) {
      const result = getDb().prepare(step.sql).run();
      if (step.expectChanges !== undefined && result.changes !== step.expectChanges) {
        throw new Error(`sql_transaction_expected_changes:${step.expectChanges}:actual:${result.changes}`);
      }
    }
  });
  transaction();
}

function getPostgresAsyncPool(): pg.Pool {
  if (postgresAsyncPool) return postgresAsyncPool;
  if (!postgresUrl) throw new Error("PostgreSQL backend selected but DATABASE_URL/AUTOMATION_OS_DATABASE_URL is missing");
  postgresAsyncPool = new pg.Pool({
    connectionString: postgresUrl,
    max: 4,
    idleTimeoutMillis: 300_000,
    connectionTimeoutMillis: 15_000,
    query_timeout: 15_000,
    statement_timeout: 15_000,
    allowExitOnIdle: true
  });
  return postgresAsyncPool;
}

/**
 * Async database boundary for request handlers.  The legacy SQL helpers are
 * intentionally synchronous because worker/CLI code still uses them, but a
 * public HTTP request must never spawn the PostgreSQL child synchronously on
 * Node's event loop.
 */
export async function querySqlAsync<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  assertAsyncDatabaseReady();
  if (dbBackend !== "postgres") return querySql<T>(sql);
  if (isPragmaTableInfo(sql)) {
    const table = extractPragmaTable(sql, "table_info");
    const result = await getPostgresAsyncPool().query(
      `SELECT column_name AS name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position;`,
      [table]
    );
    return result.rows as T[];
  }
  if (isPragmaIndexList(sql)) {
    const table = extractPragmaTable(sql, "index_list");
    const result = await getPostgresAsyncPool().query(
      `SELECT indexname AS name FROM pg_indexes WHERE schemaname=current_schema() AND tablename=$1 ORDER BY indexname;`,
      [table]
    );
    return result.rows as T[];
  }
  const result = await getPostgresAsyncPool().query(translateSqlForPostgres(sql));
  return result.rows as T[];
}

export async function execSqlAsync(sql: string): Promise<void> {
  assertAsyncDatabaseReady();
  if (dbBackend !== "postgres") {
    execSql(sql);
    return;
  }
  await getPostgresAsyncPool().query(translateSqlForPostgres(sql));
  if (!dbInitializing && affectsSchema(sql)) dbInitialized = false;
}

export async function runSqlTransactionAsync(steps: readonly SqlTransactionStep[]): Promise<void> {
  assertAsyncDatabaseReady();
  if (steps.length === 0) return;
  if (dbBackend !== "postgres") {
    runSqlTransaction(steps);
    return;
  }
  const client = await getPostgresAsyncPool().connect();
  try {
    await client.query("BEGIN");
    for (const step of steps) {
      const result = await client.query(translateSqlForPostgres(step.sql));
      if (step.expectChanges !== undefined && (result.rowCount ?? 0) !== step.expectChanges) {
        throw new Error(`sql_transaction_expected_changes:${step.expectChanges}:actual:${result.rowCount ?? 0}`);
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Execute one atomic PostgreSQL transaction as a single network round trip. */
export async function runSqlScriptAsync(statements: readonly string[]): Promise<void> {
  if (statements.length === 0) return;
  assertAsyncDatabaseReady();
  if (dbBackend !== "postgres") {
    runSqlTransaction(statements.map((sql) => ({ sql })));
    return;
  }
  const client = await getPostgresAsyncPool().connect();
  try {
    const script = ["BEGIN", ...statements.map((sql) => translateSqlForPostgres(sql)), "COMMIT"].join(";\n");
    await client.query(script);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Async request/worker paths must never fall back to the synchronous
 * PostgreSQL schema probe. Startup owns that boundary; if it is not ready,
 * fail closed with a restartable blocker instead of stalling the event loop.
 */
function assertAsyncDatabaseReady(): void {
  if (dbBackend !== "postgres") {
    initDb();
    return;
  }
  if (!dbInitialized) throw new Error("postgres_async_schema_not_ready");
}

export function initDb(): void {
  if (dbInitialized) return;
  if (dbBackend === "postgres" && postgresSchemaAssumedCurrent) {
    dbInitialized = true;
    dbInitRunCount += 1;
    return;
  }
  if (dbBackend === "postgres" && process.env.AUTOMATION_OS_POSTGRES_BOOTSTRAP_LOCK_HELD !== "1") {
    if (postgresSchemaBootstrapCurrent()) {
      dbInitialized = true;
      dbInitRunCount += 1;
      return;
    }
    dbInitializing = true;
    try {
      runPostgresWorkerInitialize();
      dbInitialized = true;
      dbInitRunCount += 1;
    } finally {
      dbInitializing = false;
    }
    return;
  }
  initializeDatabaseSchema();
}

export function initializePostgresSchemaUnderLock(): void {
  if (dbBackend !== "postgres" || process.env.AUTOMATION_OS_POSTGRES_BOOTSTRAP_LOCK_HELD !== "1") {
    throw new Error("postgres_bootstrap_advisory_lock_required");
  }
  initializeDatabaseSchema();
}

function initializeDatabaseSchema(): void {
  if (dbInitialized) return;
  if (dbBackend === "postgres" && process.env.AUTOMATION_OS_ASSUME_EXISTING_POSTGRES_SCHEMA === "1") {
    dbInitializing = true;
    try {
      runIdempotentMigrations();
      recordPostgresSchemaBootstrap();
      dbInitialized = true;
      dbInitRunCount += 1;
    } finally {
      dbInitializing = false;
    }
    return;
  }
  if (dbBackend === "sqlite") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  if (!existsSync(schemaPath)) {
    throw new Error(`Missing schema at ${schemaPath}`);
  }
  dbInitializing = true;
  try {
    const schemaSql = readFileSync(schemaPath, "utf8");
    execSql(schemaSqlForCurrentDatabase(schemaSql));
    repairLegacyDurableJobAttemptForeignKey();
    runIdempotentMigrations();
    if (dbBackend === "postgres") recordPostgresSchemaBootstrap();
    dbInitialized = true;
    dbInitRunCount += 1;
  } finally {
    dbInitializing = false;
  }
}

function repairLegacyDurableJobAttemptForeignKey(): void {
  if (dbBackend !== "sqlite") return;

  const database = getDb();
  const table = database
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='durable_job_attempts'")
    .get() as { sql?: string } | undefined;
  const tableSql = table?.sql ?? "";
  if (!/REFERENCES\s+company_users\s*\(/i.test(tableSql)) return;

  const stagingExists = database
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='durable_job_attempts__repaired'")
    .get() as { present?: number } | undefined;
  if (stagingExists?.present === 1) {
    throw new Error("durable_job_attempts_repair_staging_exists");
  }

  const columns = listTableColumns("durable_job_attempts");
  const source = (column: string, fallback: string): string => columns.has(column) ? column : fallback;
  const startedAt = source("started_at", source("created_at", "strftime('%Y-%m-%dT%H:%M:%fZ','now')"));
  const createdAt = source("created_at", startedAt);
  const updatedAt = source("updated_at", createdAt);

  database.pragma("foreign_keys = OFF");
  try {
    database.exec(`
      CREATE TABLE durable_job_attempts__repaired (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        job_id TEXT NOT NULL REFERENCES durable_jobs(id) ON DELETE CASCADE,
        attempt_no INTEGER NOT NULL,
        service_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        fencing_token INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'running',
        provider_called INTEGER NOT NULL DEFAULT 0,
        provider_called_at TEXT,
        reservation_id TEXT,
        reconciliation_started_at TEXT,
        reconciliation_owner TEXT,
        started_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        finished_at TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(job_id, attempt_no)
      );

      INSERT INTO durable_job_attempts__repaired (
        id, company_id, job_id, attempt_no, service_user_id, fencing_token, status,
        provider_called, provider_called_at, reservation_id, reconciliation_started_at,
        reconciliation_owner, started_at, heartbeat_at, finished_at, error_code,
        created_at, updated_at
      )
      SELECT
        ${source("id", "NULL")},
        ${source("company_id", "'legacy'")},
        ${source("job_id", "'legacy_job'")},
        ${source("attempt_no", "1")},
        ${source("service_user_id", "'legacy_service'")},
        ${source("fencing_token", "0")},
        ${source("status", "'running'")},
        ${source("provider_called", "0")},
        ${source("provider_called_at", "NULL")},
        ${source("reservation_id", "NULL")},
        ${source("reconciliation_started_at", "NULL")},
        ${source("reconciliation_owner", "NULL")},
        ${startedAt},
        ${source("heartbeat_at", startedAt)},
        ${source("finished_at", "NULL")},
        ${source("error_code", "NULL")},
        ${createdAt},
        ${updatedAt}
      FROM durable_job_attempts;

      DROP TABLE durable_job_attempts;
      ALTER TABLE durable_job_attempts__repaired RENAME TO durable_job_attempts;
      CREATE INDEX IF NOT EXISTS durable_job_attempts_company_idx
        ON durable_job_attempts(company_id, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS durable_job_attempts_job_idx
        ON durable_job_attempts(job_id, attempt_no DESC);
    `);
  } finally {
    database.pragma("foreign_keys = ON");
  }
}

function postgresSchemaBootstrapCurrent(): boolean {
  if (dbBackend !== "postgres") return false;
  const exists = queryPostgresSql(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema=current_schema() AND table_name='automation_os_schema_bootstrap'
    ) AS present;
  `)[0]?.present;
  if (exists !== true) return false;
  const row = queryPostgresSql(
    `SELECT version FROM ${qualifiedPostgresTable("automation_os_schema_bootstrap")} WHERE id='primary' LIMIT 1;`
  )[0];
  const databaseVersion = Number(row?.version);
  if (Number.isFinite(databaseVersion) && databaseVersion > postgresSchemaBootstrapVersion) {
    throw new Error(`postgres_schema_version_newer_than_binary:${databaseVersion}:${postgresSchemaBootstrapVersion}`);
  }
  return databaseVersion === postgresSchemaBootstrapVersion;
}

function recordPostgresSchemaBootstrap(): void {
  const table = qualifiedPostgresTable("automation_os_schema_bootstrap");
  execSql(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO ${table} (id, version, updated_at)
    VALUES ('primary', ${postgresSchemaBootstrapVersion}, ${sqlValue(nowIso())})
    ON CONFLICT(id) DO UPDATE SET version=excluded.version, updated_at=excluded.updated_at
    WHERE ${table}.version <= excluded.version;
  `);
}

export function getDbInitDiagnostics(): { initialized: boolean; initializing: boolean; runCount: number } {
  return { initialized: dbInitialized, initializing: dbInitializing, runCount: dbInitRunCount };
}

export function getDatabaseRuntimeInfo(): { backend: "sqlite"; path: string } | { backend: "postgres"; configured: boolean } {
  return dbBackend === "postgres" ? { backend: "postgres", configured: Boolean(postgresUrl) } : { backend: "sqlite", path: dbPath };
}

function affectsSchema(sql: string): boolean {
  return /\b(?:CREATE|DROP|ALTER)\s+(?:TEMP(?:ORARY)?\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)\b/i.test(sql);
}

function runIdempotentMigrations(): void {
  execSql(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      auth_provider TEXT NOT NULL DEFAULT 'legacy_operator_token',
      auth_subject TEXT NOT NULL,
      email TEXT,
      display_name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'human',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(auth_provider, auth_subject)
    );

    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS company_memberships (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'approver', 'viewer')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(company_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS company_audit_events (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      before_json TEXT NOT NULL DEFAULT '{}',
      after_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS company_memberships_user_idx ON company_memberships(user_id, status);
    CREATE INDEX IF NOT EXISTS company_memberships_company_idx ON company_memberships(company_id, status);
    CREATE INDEX IF NOT EXISTS company_audit_events_company_idx ON company_audit_events(company_id, created_at DESC);
  `);
  ensureColumn("users", "auth_provider", "TEXT NOT NULL DEFAULT 'legacy_operator_token'");
  ensureColumn("users", "auth_subject", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("runs", "company_id", "TEXT");
  ensureColumn("runs", "execution_source", "TEXT NOT NULL DEFAULT 'legacy'");
  ensureColumn("runs", "quarantined", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("runs", "readback_proof_id", "TEXT");
  ensureColumn("run_steps", "company_id", "TEXT");
  ensureColumn("approvals", "company_id", "TEXT");
  ensureColumn("approvals", "job_id", "TEXT");
  ensureColumn("approvals", "step_id", "TEXT");
  ensureColumn("approvals", "action_kind", "TEXT");
  ensureColumn("approvals", "target_account_ref_id", "TEXT");
  ensureColumn("approvals", "payload_hash", "TEXT");
  ensureColumn("approvals", "policy_version", "TEXT");
  ensureColumn("approvals", "expires_at", "TEXT");
  ensureColumn("approvals", "decided_by_user_id", "TEXT");
  ensureColumn("approvals", "decision_revision", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn("approvals", "consumed_at", "TEXT");
  ensureColumn("approvals", "consumed_by_attempt_id", "TEXT");
  ensureColumn("proofs", "company_id", "TEXT");
  ensureColumn("proofs", "artifact_id", "TEXT");
  ensureColumn("proofs", "attempt_id", "TEXT");
  ensureColumn("proofs", "fencing_token", "INTEGER");
  ensureColumn("registered_workflows", "company_id", "TEXT");
  ensureColumn("research_plans", "company_id", "TEXT");
  ensureColumn("skills", "company_id", "TEXT");
  ensureColumn("mvp_feedback", "company_id", "TEXT");
  ensureColumn("mvp_feedback", "screenshot_artifact_id", "TEXT");
  ensureColumn("lanes", "browser_use_session", "TEXT");
  ensureColumn("lanes", "browser_use_cdp_url", "TEXT");
  ensureColumn("lanes", "browser_use_profile", "TEXT");
  ensureColumn("lanes", "profile_strategy", "TEXT NOT NULL DEFAULT 'browser_use_cli_lifecycle'");
  ensureColumn("lanes", "lane_visibility", "TEXT NOT NULL DEFAULT 'visible'");
  ensureColumn("registered_workflows", "start_command_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn("research_plans", "sources_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("research_plans", "visible_flow_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("research_plans", "source_of_truth_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("research_plans", "proof_boundary_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("research_plans", "approval_boundary_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("research_plans", "metadata_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn("research_plans", "demo_check_id", "TEXT");
  ensureColumn("research_plans", "run_id", "TEXT");
  execSql(`
    CREATE INDEX IF NOT EXISTS idx_runs_company ON runs(company_id);
    CREATE INDEX IF NOT EXISTS idx_runs_worker_claim ON runs(execution_source, quarantined, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_approvals_company_status ON approvals(company_id, status);
    CREATE INDEX IF NOT EXISTS idx_approvals_bound_action ON approvals(company_id, job_id, status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_proofs_company_run ON proofs(company_id, run_id);
    CREATE INDEX IF NOT EXISTS idx_registered_workflows_company ON registered_workflows(company_id);
    CREATE INDEX IF NOT EXISTS idx_research_plans_company ON research_plans(company_id);
    CREATE INDEX IF NOT EXISTS idx_skills_company ON skills(company_id);
    CREATE INDEX IF NOT EXISTS mvp_feedback_company_idx ON mvp_feedback(company_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS feedback_artifacts (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      feedback_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL DEFAULT 'screenshot',
      mime_type TEXT NOT NULL,
      checksum_sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      content_base64 TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'available',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS feedback_artifacts_company_idx ON feedback_artifacts(company_id, created_at DESC);
  `);
  ensureColumn("create_sessions", "title", "TEXT NOT NULL DEFAULT '作る相談'");
  ensureColumn("create_sessions", "messages_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("create_sessions", "draft_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn("create_sessions", "research_sources_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn("create_sessions", "command", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("create_sessions", "created_at", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("create_sessions", "updated_at", "TEXT NOT NULL DEFAULT ''");
  execSql(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      codex_thread_id TEXT,
      is_active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(company_id, actor_user_id, name)
    );
    CREATE INDEX IF NOT EXISTS chat_sessions_scope_idx
      ON chat_sessions(company_id, actor_user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS chat_sessions_thread_idx
      ON chat_sessions(codex_thread_id);
  `);
  ensureColumn("create_planner_jobs", "status", "TEXT NOT NULL DEFAULT 'queued'");
  ensureColumn("create_planner_jobs", "messages_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("create_planner_jobs", "current_draft", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("create_planner_jobs", "result_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn("create_planner_jobs", "exact_blocker", "TEXT");
  ensureColumn("create_planner_jobs", "created_at", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("create_planner_jobs", "updated_at", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("create_planner_jobs", "started_at", "TEXT");
  ensureColumn("create_planner_jobs", "completed_at", "TEXT");
  ensureColumn("create_planner_jobs", "metadata_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn("create_planner_jobs", "lease_owner", "TEXT");
  ensureColumn("create_planner_jobs", "lease_expires_at", "TEXT");
  ensureColumn("create_planner_jobs", "attempt_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("stored_secrets", "company_id", "TEXT");
  ensureColumn("worker_events", "company_id", "TEXT");
  ensureColumn("runs", "automation_id", "TEXT");
  ensureColumn("runs", "automation_version_id", "TEXT");
  execSql(`
    CREATE TABLE IF NOT EXISTS mvp_automations (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      automation_type TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      "desc" TEXT NOT NULL DEFAULT '',
      goal TEXT NOT NULL,
      schedule TEXT NOT NULL,
      cadence TEXT NOT NULL,
      lane TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      approval_policy TEXT NOT NULL,
      worker_command_kind TEXT NOT NULL,
      create_approval INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'draft',
      builder_spec_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS mvp_automations_project_idx ON mvp_automations(project_id);
    CREATE INDEX IF NOT EXISTS mvp_automations_updated_at_idx ON mvp_automations(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_company ON runs(company_id);
    CREATE INDEX IF NOT EXISTS idx_runs_automation ON runs(automation_id);
    CREATE INDEX IF NOT EXISTS idx_runs_automation_version ON runs(automation_version_id);
  `);
  ensureColumn("mvp_automations", "company_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("mvp_automations", "description", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("mvp_automations", "desc", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("mvp_automations", "current_version_id", "TEXT");
  ensureColumn("mvp_automations", "revision", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn("mvp_automations", "archived_at", "TEXT");
  if (listTableColumns("mvp_automations").has("desc")) {
    execSql("UPDATE mvp_automations SET description=\"desc\" WHERE trim(description)='' AND \"desc\" IS NOT NULL;");
    execSql("UPDATE mvp_automations SET \"desc\"=description WHERE trim(\"desc\")='' AND description IS NOT NULL;");
  }
  execSql("CREATE INDEX IF NOT EXISTS mvp_automations_company_idx ON mvp_automations(company_id);");
  execSql("CREATE INDEX IF NOT EXISTS mvp_automations_current_version_idx ON mvp_automations(current_version_id);");
  execSql(`
    CREATE TABLE IF NOT EXISTS mvp_automation_versions (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      automation_id TEXT NOT NULL REFERENCES mvp_automations(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL DEFAULT 1,
      automation_type TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      goal TEXT NOT NULL,
      schedule TEXT NOT NULL,
      cadence TEXT NOT NULL,
      lane TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      approval_policy TEXT NOT NULL,
      worker_command_kind TEXT NOT NULL,
      create_approval INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'draft',
      builder_spec_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(automation_id, revision)
    );

    CREATE INDEX IF NOT EXISTS mvp_automation_versions_company_idx ON mvp_automation_versions(company_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS mvp_automation_versions_automation_idx ON mvp_automation_versions(automation_id, revision DESC);

    CREATE TABLE IF NOT EXISTS mvp_automation_schedules (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      automation_id TEXT NOT NULL REFERENCES mvp_automations(id) ON DELETE CASCADE,
      automation_version_id TEXT REFERENCES mvp_automation_versions(id) ON DELETE SET NULL,
      kind TEXT NOT NULL,
      expression TEXT,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      enabled INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active',
      revision INTEGER NOT NULL DEFAULT 1,
      next_run_at TEXT,
      last_run_at TEXT,
      paused_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(company_id, automation_id)
    );

    CREATE INDEX IF NOT EXISTS mvp_automation_schedules_company_idx ON mvp_automation_schedules(company_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS mvp_automation_schedules_automation_idx ON mvp_automation_schedules(automation_id, revision DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS mvp_automation_schedules_single_idx ON mvp_automation_schedules(company_id, automation_id);

    CREATE TABLE IF NOT EXISTS durable_schedule_occurrences (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      schedule_id TEXT NOT NULL REFERENCES mvp_automation_schedules(id) ON DELETE CASCADE,
      occurrence_key TEXT NOT NULL,
      scheduled_for TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      job_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(company_id, occurrence_key)
    );

    CREATE INDEX IF NOT EXISTS durable_schedule_occurrences_company_idx ON durable_schedule_occurrences(company_id, status, scheduled_for DESC);
    CREATE INDEX IF NOT EXISTS durable_schedule_occurrences_schedule_idx ON durable_schedule_occurrences(schedule_id, scheduled_for DESC);

    CREATE TABLE IF NOT EXISTS durable_concurrency_slots (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      concurrency_key TEXT NOT NULL,
      slot_limit INTEGER NOT NULL DEFAULT 1,
      active_count INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(company_id, concurrency_key)
    );

    CREATE INDEX IF NOT EXISTS durable_concurrency_slots_company_idx ON durable_concurrency_slots(company_id, concurrency_key, updated_at DESC);

    CREATE TABLE IF NOT EXISTS durable_jobs (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      automation_id TEXT REFERENCES mvp_automations(id) ON DELETE SET NULL,
      automation_version_id TEXT REFERENCES mvp_automation_versions(id) ON DELETE SET NULL,
      schedule_occurrence_id TEXT REFERENCES durable_schedule_occurrences(id) ON DELETE SET NULL,
      concurrency_key TEXT NOT NULL,
      max_concurrency INTEGER NOT NULL DEFAULT 1,
      kind TEXT NOT NULL,
      execution_mode TEXT NOT NULL DEFAULT 'dry_run',
      external_intent_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'queued',
      payload_json TEXT NOT NULL DEFAULT '{}',
      payload_hash TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 100,
      max_attempts INTEGER NOT NULL DEFAULT 1,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_expires_at TEXT,
      fencing_token INTEGER NOT NULL DEFAULT 0,
      heartbeat_at TEXT,
      provider_called INTEGER NOT NULL DEFAULT 0,
      reservation_id TEXT,
      reconciliation_started_at TEXT,
      reconciliation_owner TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(company_id, idempotency_key)
    );

    CREATE INDEX IF NOT EXISTS durable_jobs_company_idx ON durable_jobs(company_id, status, priority DESC, available_at ASC, created_at DESC);
    CREATE INDEX IF NOT EXISTS durable_jobs_run_idx ON durable_jobs(run_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS durable_jobs_automation_idx ON durable_jobs(automation_id, automation_version_id, status, available_at ASC);
    CREATE INDEX IF NOT EXISTS durable_jobs_schedule_occurrence_idx ON durable_jobs(schedule_occurrence_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS durable_jobs_concurrency_idx ON durable_jobs(company_id, concurrency_key, status, available_at ASC, created_at DESC);

    CREATE TABLE IF NOT EXISTS durable_job_attempts (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL REFERENCES durable_jobs(id) ON DELETE CASCADE,
      attempt_no INTEGER NOT NULL,
      service_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      fencing_token INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'running',
      provider_called INTEGER NOT NULL DEFAULT 0,
      provider_called_at TEXT,
      reservation_id TEXT,
      reconciliation_started_at TEXT,
      reconciliation_owner TEXT,
      started_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      finished_at TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(job_id, attempt_no)
    );

    CREATE INDEX IF NOT EXISTS durable_job_attempts_company_idx ON durable_job_attempts(company_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS durable_job_attempts_job_idx ON durable_job_attempts(job_id, attempt_no DESC);

    CREATE TABLE IF NOT EXISTS run_artifacts (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      step_id TEXT REFERENCES run_steps(id) ON DELETE SET NULL,
      attempt_id TEXT REFERENCES durable_job_attempts(id) ON DELETE SET NULL,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      checksum_sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      content_text TEXT,
      status TEXT NOT NULL DEFAULT 'available',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS run_artifacts_company_idx ON run_artifacts(company_id, kind, created_at DESC);
    CREATE INDEX IF NOT EXISTS run_artifacts_run_idx ON run_artifacts(run_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS run_artifacts_step_idx ON run_artifacts(step_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS mvp_idempotency_keys (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      scope TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      response_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(company_id, scope, idempotency_key)
    );

    CREATE INDEX IF NOT EXISTS mvp_idempotency_keys_company_idx ON mvp_idempotency_keys(company_id, scope, status, created_at DESC);

    CREATE TABLE IF NOT EXISTS portable_workflow_invocations (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      source_trigger TEXT NOT NULL,
      company_scope TEXT NOT NULL,
      company_id TEXT,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
      run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workflow_id, source_trigger, company_scope, idempotency_key)
    );

    CREATE INDEX IF NOT EXISTS portable_workflow_invocations_run_idx
      ON portable_workflow_invocations(run_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS company_memory_entries (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      memory_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active',
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(company_id, memory_key)
    );

    CREATE INDEX IF NOT EXISTS company_memory_entries_company_idx ON company_memory_entries(company_id, status, created_at DESC);

    CREATE TABLE IF NOT EXISTS company_connection_account_refs (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      account_ref TEXT NOT NULL,
      status TEXT NOT NULL,
      scopes_json TEXT NOT NULL DEFAULT '[]',
      expires_at TEXT,
      oauth_state TEXT NOT NULL DEFAULT 'not_configured',
      verification_status TEXT NOT NULL DEFAULT 'unverified',
      last_verified_at TEXT,
      reconnect_requested_at TEXT,
      revoked_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(company_id, platform, account_ref)
    );

    CREATE INDEX IF NOT EXISTS company_connection_account_refs_company_idx ON company_connection_account_refs(company_id, status, updated_at DESC);
  `);
  ensureColumn("durable_jobs", "execution_mode", "TEXT NOT NULL DEFAULT 'dry_run'");
  ensureColumn("durable_jobs", "external_intent_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn("durable_jobs", "provider_called", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("durable_jobs", "reservation_id", "TEXT");
  ensureColumn("durable_jobs", "reconciliation_started_at", "TEXT");
  ensureColumn("durable_jobs", "reconciliation_owner", "TEXT");
  ensureColumn("durable_job_attempts", "provider_called", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("durable_job_attempts", "provider_called_at", "TEXT");
  ensureColumn("durable_job_attempts", "reservation_id", "TEXT");
  ensureColumn("durable_job_attempts", "reconciliation_started_at", "TEXT");
  ensureColumn("durable_job_attempts", "reconciliation_owner", "TEXT");
  ensureColumn("company_connection_account_refs", "oauth_state", "TEXT NOT NULL DEFAULT 'not_configured'");
  ensureColumn("company_connection_account_refs", "verification_status", "TEXT NOT NULL DEFAULT 'unverified'");
  ensureColumn("company_connection_account_refs", "last_verified_at", "TEXT");
  ensureColumn("company_connection_account_refs", "reconnect_requested_at", "TEXT");
  ensureColumn("company_connection_account_refs", "revoked_at", "TEXT");
  backfillImmutableMvpAutomationVersions();
  ensureColumn("child_runs", "parent_run_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("child_runs", "step_id", "TEXT");
  ensureColumn("child_runs", "role", "TEXT NOT NULL DEFAULT 'child_codex'");
  ensureColumn("child_runs", "prompt_uri", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("child_runs", "status", "TEXT NOT NULL DEFAULT 'queued'");
  ensureColumn("child_runs", "pid", "INTEGER");
  ensureColumn("child_runs", "exit_status", "INTEGER");
  ensureColumn("child_runs", "signal", "TEXT");
  ensureColumn("child_runs", "result_uri", "TEXT");
  ensureColumn("child_runs", "summary", "TEXT");
  ensureColumn("child_runs", "blocker", "TEXT");
  ensureColumn("child_runs", "created_at", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("child_runs", "started_at", "TEXT");
  ensureColumn("child_runs", "completed_at", "TEXT");
  ensureColumn("child_runs", "metadata_json", "TEXT NOT NULL DEFAULT '{}'");
  execSql(`
    CREATE INDEX IF NOT EXISTS idx_child_runs_parent ON child_runs(parent_run_id);
    CREATE INDEX IF NOT EXISTS idx_child_runs_step ON child_runs(step_id);
    CREATE INDEX IF NOT EXISTS idx_research_plans_updated ON research_plans(updated_at);
    CREATE INDEX IF NOT EXISTS idx_research_plans_status ON research_plans(status);
    CREATE INDEX IF NOT EXISTS idx_create_planner_jobs_status ON create_planner_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_create_planner_jobs_updated ON create_planner_jobs(updated_at);
    CREATE INDEX IF NOT EXISTS idx_create_planner_jobs_lease ON create_planner_jobs(status, lease_expires_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_stored_secrets_company_kind ON stored_secrets(company_id, kind, updated_at DESC);
  `);
  execSql(`
    CREATE TABLE IF NOT EXISTS service_readiness_effect_ledger (
      effect_key TEXT PRIMARY KEY CHECK (length(effect_key) = 64),
      company_id TEXT NOT NULL DEFAULT 'legacy',
      reservation_id TEXT NOT NULL DEFAULT '',
      reservation_token_hash TEXT,
      capability_id TEXT NOT NULL DEFAULT '',
      approval_id TEXT NOT NULL DEFAULT '',
      approval_revision INTEGER NOT NULL DEFAULT 0,
      root_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      stage_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      fencing_token INTEGER NOT NULL CHECK (fencing_token >= 0),
      provider TEXT NOT NULL,
      account_ref TEXT NOT NULL,
      target_hash TEXT NOT NULL CHECK (length(target_hash) = 64),
      payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
      effect_class TEXT NOT NULL CHECK (effect_class IN ('internal_idempotent', 'external_non_idempotent')),
      status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'blocked', 'reconciliation_required', 'cancelled')),
      external_action_executed INTEGER NOT NULL CHECK (external_action_executed IN (0, 1)),
      provider_receipt_hash TEXT,
      cleanup_receipt_hash TEXT,
      exact_blocker TEXT,
      safe_resume_step TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      terminal_at TEXT
    );

  `);
  ensureColumn("service_readiness_effect_ledger", "company_id", "TEXT NOT NULL DEFAULT 'legacy'");
  ensureColumn("service_readiness_effect_ledger", "reservation_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("service_readiness_effect_ledger", "reservation_token_hash", "TEXT");
  ensureColumn("service_readiness_effect_ledger", "capability_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("service_readiness_effect_ledger", "approval_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("service_readiness_effect_ledger", "approval_revision", "INTEGER NOT NULL DEFAULT 0");
  execSql(`
    CREATE INDEX IF NOT EXISTS service_readiness_effect_ledger_binding_idx
      ON service_readiness_effect_ledger(company_id, root_id, workflow_id, run_id, stage_id, attempt_id, fencing_token);
    CREATE INDEX IF NOT EXISTS service_readiness_effect_ledger_status_idx
      ON service_readiness_effect_ledger(status, updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS service_readiness_effect_ledger_company_effect_idx
      ON service_readiness_effect_ledger(company_id, effect_key);
    CREATE UNIQUE INDEX IF NOT EXISTS service_readiness_effect_ledger_company_capability_idx
      ON service_readiness_effect_ledger(company_id, capability_id)
      WHERE capability_id <> '';
  `);
  execSql(`
    CREATE TABLE IF NOT EXISTS task_effect_ledger (
      operation_key TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      target_hash TEXT NOT NULL CHECK (length(target_hash) = 64),
      payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
      audience_hash TEXT NOT NULL CHECK (length(audience_hash) = 64),
      state TEXT NOT NULL CHECK (state IN ('planned', 'admitted', 'executing', 'intent', 'confirmed', 'reconciled', 'closed')),
      external_action_executed INTEGER NOT NULL CHECK (external_action_executed IN (0, 1)),
      ambiguous INTEGER NOT NULL CHECK (ambiguous IN (0, 1)),
      retry_forbidden INTEGER NOT NULL CHECK (retry_forbidden IN (0, 1)),
      provider_receipt_hash TEXT,
      source_sync_hash TEXT,
      reconciliation_hash TEXT,
      cleanup_hash TEXT,
      exact_blocker TEXT,
      restart_point TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT,
      UNIQUE(company_id, operation_key)
    );
    CREATE INDEX IF NOT EXISTS task_effect_ledger_company_state_idx
      ON task_effect_ledger(company_id, state, updated_at DESC);
    CREATE INDEX IF NOT EXISTS task_effect_ledger_trace_idx
      ON task_effect_ledger(company_id, trace_id, updated_at DESC);
  `);
  execSql(`
    CREATE TABLE IF NOT EXISTS job_application_target_admissions (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      workflow_id TEXT NOT NULL CHECK (workflow_id = 'job-application-manager'),
      registered_automation_id TEXT,
      candidate_key TEXT NOT NULL,
      job_url TEXT,
      job_id TEXT,
      application_url TEXT,
      company_name TEXT NOT NULL,
      role TEXT NOT NULL,
      account_ref TEXT NOT NULL,
      audience_json TEXT NOT NULL,
      resume_locale TEXT NOT NULL,
      resume_sha256 TEXT NOT NULL CHECK (length(resume_sha256) = 64),
      payload_ref TEXT,
      payload_sha256 TEXT CHECK (payload_sha256 IS NULL OR length(payload_sha256) = 64),
      input_bundle_ref TEXT,
      input_bundle_sha256 TEXT CHECK (input_bundle_sha256 IS NULL OR length(input_bundle_sha256) = 64),
      owner_ref TEXT NOT NULL,
      authority_ref TEXT NOT NULL,
      approval_action_kind TEXT NOT NULL,
      approval_policy_version TEXT NOT NULL,
      approval_id TEXT,
      approval_status TEXT NOT NULL DEFAULT 'not_started'
        CHECK (approval_status IN ('not_started', 'pending', 'approved', 'rejected', 'expired')),
      idempotency_key TEXT NOT NULL,
      source_snapshot_id TEXT NOT NULL,
      source_snapshot_expires_at TEXT NOT NULL,
      bucket TEXT NOT NULL CHECK (bucket IN ('japan_targeted', 'overseas_global')),
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      attempt INTEGER NOT NULL CHECK (attempt >= 1),
      supply_run_id TEXT NOT NULL,
      target_digest TEXT NOT NULL CHECK (length(target_digest) = 64),
      status TEXT NOT NULL DEFAULT 'registered'
        CHECK (status IN ('registered', 'approval_pending', 'approved', 'running', 'submitted', 'reconciled', 'blocked', 'rejected', 'expired', 'cancelled')),
      run_id TEXT,
      trigger_idempotency_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(company_id, workflow_id, candidate_key),
      UNIQUE(company_id, workflow_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS job_application_target_admissions_company_idx
      ON job_application_target_admissions(company_id, workflow_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS job_application_target_admissions_run_idx
      ON job_application_target_admissions(company_id, run_id, updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS job_application_target_admissions_one_active_idx
      ON job_application_target_admissions(company_id, workflow_id)
      WHERE status IN ('registered', 'approval_pending', 'approved', 'running', 'submitted', 'reconciled');
  `);
  normalizeLaneDefaults();
}

function normalizeLaneDefaults(): void {
  execSql(`
    UPDATE lanes
    SET profile_strategy='browser_use_cli_lifecycle'
    WHERE profile_strategy IS NULL OR trim(profile_strategy)='';

    UPDATE lanes
    SET lane_visibility='visible'
    WHERE lane_visibility IS NULL OR trim(lane_visibility)='';
  `);
}

function backfillImmutableMvpAutomationVersions(): void {
  execSql(`
    INSERT INTO mvp_automation_versions (
      id, company_id, project_id, automation_id, revision, automation_type, name, description, goal,
      schedule, cadence, lane, risk_level, approval_policy, worker_command_kind, create_approval,
      status, builder_spec_json, created_at, updated_at
    )
    SELECT
      'mvpav_' || a.id || '_v1',
      a.company_id,
      a.project_id,
      a.id,
      1,
      a.automation_type,
      a.name,
      a.description,
      a.goal,
      a.schedule,
      a.cadence,
      a.lane,
      a.risk_level,
      a.approval_policy,
      a.worker_command_kind,
      a.create_approval,
      a.status,
      a.builder_spec_json,
      a.created_at,
      a.updated_at
    FROM mvp_automations a
    WHERE NOT EXISTS (
      SELECT 1 FROM mvp_automation_versions v
      WHERE v.automation_id = a.id AND v.revision = 1
    );

    UPDATE mvp_automations
    SET current_version_id = COALESCE(NULLIF(current_version_id, ''), 'mvpav_' || id || '_v1'),
        revision = COALESCE(NULLIF(revision, 0), 1)
    WHERE EXISTS (
      SELECT 1 FROM mvp_automation_versions v
      WHERE v.automation_id = mvp_automations.id AND v.revision = 1
    );
  `);
}

function ensureColumn(table: string, column: string, definition: string): void {
  const columns = listTableColumns(table);
  if (columns.has(column)) return;
  execSql(
    dbBackend === "postgres"
      ? `ALTER TABLE ${qualifiedPostgresTable(table)} ADD COLUMN IF NOT EXISTS ${quotePostgresIdentifier(column)} ${definition};`
      : `ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`
  );
}

function qualifiedPostgresTable(table: string): string {
  const schema = queryPostgresSql("SELECT current_schema() AS schema_name;")[0]?.schema_name;
  if (typeof schema !== "string" || !schema.trim()) throw new Error("postgres_current_schema_missing");
  return `${quotePostgresIdentifier(schema)}.${quotePostgresIdentifier(table)}`;
}

function quotePostgresIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function schemaSqlForCurrentDatabase(schemaSql: string): string {
  const legacyTenantTables = ["runs", "approvals", "proofs", "registered_workflows", "research_plans", "skills", "mvp_feedback"];
  const existingRunColumns = listTableColumns("runs");
  const needsLegacyCompat = legacyTenantTables.some((table) => {
    const columns = listTableColumns(table);
    return columns.size > 0 && !columns.has("company_id");
  });
  let compatible = schemaSql;
  if (needsLegacyCompat) {
    compatible = compatible
      .replace(/^CREATE INDEX IF NOT EXISTS idx_runs_company ON runs\(company_id\);\s*$/gim, "")
      .replace(/^CREATE INDEX IF NOT EXISTS idx_runs_worker_claim ON runs\(execution_source, quarantined, status, created_at\);\s*$/gim, "")
      .replace(/^CREATE INDEX IF NOT EXISTS idx_approvals_company_status ON approvals\(company_id, status\);\s*$/gim, "")
      .replace(/^CREATE INDEX IF NOT EXISTS idx_proofs_company_run ON proofs\(company_id, run_id\);\s*$/gim, "")
      .replace(/^CREATE INDEX IF NOT EXISTS idx_registered_workflows_company ON registered_workflows\(company_id\);\s*$/gim, "")
      .replace(/^CREATE INDEX IF NOT EXISTS idx_research_plans_company ON research_plans\(company_id\);\s*$/gim, "")
      .replace(/^CREATE INDEX IF NOT EXISTS idx_skills_company ON skills\(company_id\);\s*$/gim, "")
      .replace(/^CREATE INDEX IF NOT EXISTS mvp_automations_company_idx ON mvp_automations\(company_id\);\s*$/gim, "")
      .replace(/^CREATE INDEX IF NOT EXISTS mvp_feedback_company_idx ON mvp_feedback\(company_id, created_at DESC\);\s*$/gim, "");
  }
  if (existingRunColumns.size > 0 && !existingRunColumns.has("execution_source")) {
    compatible = compatible.replace(
      /^CREATE INDEX IF NOT EXISTS idx_runs_worker_claim ON runs\(execution_source, quarantined, status, created_at\);\s*$/gim,
      ""
    );
  }
  const runColumns = listTableColumns("runs");
  if (runColumns.size > 0 && (!runColumns.has("automation_id") || !runColumns.has("automation_version_id"))) {
    compatible = compatible
      .replace(/^CREATE INDEX IF NOT EXISTS idx_runs_automation ON runs\(automation_id\);\s*$/gim, "")
      .replace(/^CREATE INDEX IF NOT EXISTS idx_runs_automation_version ON runs\(automation_version_id\);\s*$/gim, "");
  }
  const approvalColumns = listTableColumns("approvals");
  if (approvalColumns.size > 0 && ["company_id", "job_id", "expires_at"].some((column) => !approvalColumns.has(column))) {
    compatible = compatible.replace(
      /^CREATE INDEX IF NOT EXISTS idx_approvals_bound_action ON approvals\(company_id, job_id, status, expires_at\);\s*$/gim,
      ""
    );
  }
  const automationColumns = listTableColumns("mvp_automations");
  if (automationColumns.size > 0 && !automationColumns.has("current_version_id")) {
    compatible = compatible.replace(/^CREATE INDEX IF NOT EXISTS mvp_automations_current_version_idx ON mvp_automations\(current_version_id\);\s*$/gim, "");
  }
  return compatible;
}

function listTableColumns(table: string): Set<string> {
  if (dbBackend === "postgres") {
    const rows = queryPostgresSql(
      `SELECT column_name AS name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=${sqlValue(table)} ORDER BY ordinal_position;`
    ) as Array<{ name?: string }>;
    return new Set(rows.map((row) => row.name).filter((name): name is string => Boolean(name)));
  }
  const rows = getDb().prepare(`PRAGMA table_info(${table});`).all() as Array<{ name?: string }>;
  return new Set(rows.map((row) => row.name).filter((name): name is string => Boolean(name)));
}

function getDb(): Database.Database {
  if (dbConnection) return dbConnection;
  mkdirSync(dirname(dbPath), { recursive: true });
  dbConnection = new Database(dbPath);
  dbConnection.pragma("busy_timeout = 10000");
  return dbConnection;
}

export function insert(table: string, row: Record<string, SqlValue>): void {
  const normalizedRow = table === "runs" && row.execution_source === undefined
    ? { ...row, execution_source: "automation-os", quarantined: row.quarantined ?? 0 }
    : row;
  const columns = Object.keys(normalizedRow);
  const values = columns.map((column) => sqlValue(normalizedRow[column]));
  execSql(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${values.join(", ")});`);
}

export function upsert(table: string, row: Record<string, SqlValue>, conflictColumn = "id"): void {
  const normalizedRow = table === "runs" && row.execution_source === undefined
    ? { ...row, execution_source: "automation-os", quarantined: row.quarantined ?? 0 }
    : row;
  const columns = Object.keys(normalizedRow);
  const values = columns.map((column) => sqlValue(normalizedRow[column]));
  const updates = columns
    .filter((column) => column !== conflictColumn)
    .map((column) => `${column}=excluded.${column}`)
    .join(", ");
  execSql(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${values.join(", ")}) ` +
      `ON CONFLICT(${conflictColumn}) DO UPDATE SET ${updates};`
  );
}

export function resetDemoData(): void {
  execSql(`
    DELETE FROM skills;
    DELETE FROM advisor_events;
    DELETE FROM worker_events;
    DELETE FROM child_runs;
    DELETE FROM durable_job_attempts;
    DELETE FROM durable_jobs;
    DELETE FROM durable_schedule_occurrences;
    DELETE FROM durable_concurrency_slots;
    DELETE FROM run_artifacts;
    DELETE FROM feedback_artifacts;
    DELETE FROM proofs;
    DELETE FROM approvals;
    DELETE FROM run_steps;
    DELETE FROM portable_workflow_invocations;
    DELETE FROM lanes;
    DELETE FROM runs;
    DELETE FROM research_plans;
    DELETE FROM create_planner_jobs;
  `);
}

export type CleanDevDataOptions = {
  artifactRoot?: string;
  backupRoot?: string;
  dryRun?: boolean;
  backupTimestamp?: string;
};

export type CleanDevDataResult = {
  database: string;
  artifactRoot: string;
  artifactsRemoved: boolean;
  dryRun: boolean;
  backupDir?: string;
  artifactManifest?: string;
  databaseBackups: string[];
};

export function cleanDevData(options: CleanDevDataOptions = {}): CleanDevDataResult {
  if (dbBackend === "postgres") {
    throw new Error("cleanDevData is only supported for the local SQLite backend. Use explicit PostgreSQL backup/restore tooling before destructive cleanup.");
  }
  const artifactRoot = options.artifactRoot ?? resolve(process.cwd(), "data", "artifacts");
  const artifactsRemoved = existsSync(artifactRoot);
  if (options.dryRun) {
    return { database: dbPath, artifactRoot, artifactsRemoved, dryRun: true, databaseBackups: [] };
  }

  const backup = createCleanDevDataBackup({
    artifactRoot,
    backupRoot: options.backupRoot ?? resolve(process.cwd(), "data", "backups"),
    timestamp: options.backupTimestamp ?? new Date().toISOString()
  });

  resetDemoData();
  rmSync(artifactRoot, { recursive: true, force: true });
  return {
    database: dbPath,
    artifactRoot,
    artifactsRemoved,
    dryRun: false,
    backupDir: backup.backupDir,
    artifactManifest: backup.artifactManifest,
    databaseBackups: backup.databaseBackups
  };
}

function execPostgresSql(sql: string): void {
  runPostgresWorker("exec", sql);
}

function queryPostgresSql(sql: string): Array<Record<string, unknown>> {
  if (isPragmaTableInfo(sql)) {
    const table = extractPragmaTable(sql, "table_info");
    return runPostgresWorker(
      "query",
      `SELECT column_name AS name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=${sqlValue(table)} ORDER BY ordinal_position;`
    );
  }
  if (isPragmaIndexList(sql)) {
    const table = extractPragmaTable(sql, "index_list");
    return runPostgresWorker("query", `SELECT indexname AS name FROM pg_indexes WHERE schemaname=current_schema() AND tablename=${sqlValue(table)} ORDER BY indexname;`);
  }
  return runPostgresWorker("query", translateSqlForPostgres(sql));
}

function queryPostgresSqlBatch(sqls: string[]): Array<Array<Record<string, unknown>>> {
  return runPostgresWorkerBatch(sqls.map((sql) => translateSqlForPostgres(sql)));
}

function runPostgresWorker(operation: "exec" | "query", sql: string): Array<Record<string, unknown>> {
  if (!postgresUrl) throw new Error("PostgreSQL backend selected but DATABASE_URL/AUTOMATION_OS_DATABASE_URL is missing");
  const command = resolvePostgresWorkerCommand();
  try {
    const stdout = execFileSync(command.bin, command.args, {
      cwd: process.cwd(),
      env: { ...process.env, AUTOMATION_OS_POSTGRES_URL: postgresUrl },
      input: `${JSON.stringify({ operation, sql: translateSqlForPostgres(sql) })}\n`,
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      timeout: postgresWorkerTimeoutMs
    });
    const parsed = JSON.parse(stdout) as { ok: boolean; rows?: Array<Record<string, unknown>>; error?: string };
    if (!parsed.ok) throw new Error(`${parsed.error ?? "PostgreSQL worker failed"}\nSQL: ${sql}`);
    return parsed.rows ?? [];
  } catch (error) {
    const stderr = typeof error === "object" && error && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "").trim() : "";
    const stdout = typeof error === "object" && error && "stdout" in error ? String((error as { stdout?: unknown }).stdout ?? "").trim() : "";
    const detail = [stdout, stderr].filter(Boolean).join("\n").trim();
    if (detail) {
      throw new Error(detail);
    }
    throw error;
  }
}

function runPostgresWorkerBatch(sqls: string[]): Array<Array<Record<string, unknown>>> {
  if (!postgresUrl) throw new Error("PostgreSQL backend selected but DATABASE_URL/AUTOMATION_OS_DATABASE_URL is missing");
  const command = resolvePostgresWorkerCommand();
  try {
    const stdout = execFileSync(command.bin, command.args, {
      cwd: process.cwd(),
      env: { ...process.env, AUTOMATION_OS_POSTGRES_URL: postgresUrl },
      input: `${JSON.stringify({ operation: "batchQuery", sqls })}\n`,
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      timeout: postgresWorkerTimeoutMs
    });
    const parsed = JSON.parse(stdout) as { ok: boolean; batches?: Array<Array<Record<string, unknown>>>; error?: string };
    if (!parsed.ok) throw new Error(`${parsed.error ?? "PostgreSQL worker failed"}\nSQL: ${sqls.join(";\n")}`);
    return parsed.batches ?? [];
  } catch (error) {
    const stderr = typeof error === "object" && error && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "").trim() : "";
    const stdout = typeof error === "object" && error && "stdout" in error ? String((error as { stdout?: unknown }).stdout ?? "").trim() : "";
    const detail = [stdout, stderr].filter(Boolean).join("\n").trim();
    if (detail) {
      throw new Error(detail);
    }
    throw error;
  }
}

function runPostgresWorkerTransaction(steps: readonly SqlTransactionStep[]): void {
  if (!postgresUrl) throw new Error("PostgreSQL backend selected but DATABASE_URL/AUTOMATION_OS_DATABASE_URL is missing");
  const command = resolvePostgresWorkerCommand();
  try {
    const stdout = execFileSync(command.bin, command.args, {
      cwd: process.cwd(),
      env: { ...process.env, AUTOMATION_OS_POSTGRES_URL: postgresUrl },
      input: `${JSON.stringify({ operation: "transaction", steps })}\n`,
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      timeout: postgresWorkerTimeoutMs
    });
    const parsed = JSON.parse(stdout) as { ok: boolean; error?: string };
    if (!parsed.ok) throw new Error(parsed.error ?? "PostgreSQL transaction worker failed");
  } catch (error) {
    const stderr = typeof error === "object" && error && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "").trim() : "";
    const stdout = typeof error === "object" && error && "stdout" in error ? String((error as { stdout?: unknown }).stdout ?? "").trim() : "";
    const detail = [stdout, stderr].filter(Boolean).join("\n").trim();
    if (detail) throw new Error(detail);
    throw error;
  }
}

function runPostgresWorkerInitialize(): void {
  if (!postgresUrl) throw new Error("PostgreSQL backend selected but DATABASE_URL/AUTOMATION_OS_DATABASE_URL is missing");
  const command = resolvePostgresWorkerCommand();
  const timeoutMs = Math.max(postgresWorkerTimeoutMs, 120_000);
  try {
    const stdout = execFileSync(command.bin, command.args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AUTOMATION_OS_POSTGRES_URL: postgresUrl,
        AUTOMATION_OS_POSTGRES_WORKER_TIMEOUT_MS: String(timeoutMs)
      },
      input: `${JSON.stringify({ operation: "initialize", bootstrapVersion: postgresSchemaBootstrapVersion })}\n`,
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      timeout: timeoutMs
    });
    const parsed = JSON.parse(stdout) as { ok: boolean; error?: string };
    if (!parsed.ok) throw new Error(parsed.error ?? "PostgreSQL initialize worker failed");
  } catch (error) {
    const stderr = typeof error === "object" && error && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "").trim() : "";
    const stdout = typeof error === "object" && error && "stdout" in error ? String((error as { stdout?: unknown }).stdout ?? "").trim() : "";
    const detail = [stdout, stderr].filter(Boolean).join("\n").trim();
    if (detail) throw new Error(detail);
    throw error;
  }
}

function resolvePostgresWorkerCommand(): { bin: string; args: string[] } {
  const compiledWorker = resolve(moduleDir, "postgresWorker.js");
  if (existsSync(compiledWorker)) return { bin: process.execPath, args: [compiledWorker] };
  const sourceWorker = resolve(moduleDir, "postgresWorker.ts");
  const tsxBin = resolve(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  if (existsSync(sourceWorker) && existsSync(tsxBin)) return { bin: tsxBin, args: [sourceWorker] };
  return { bin: process.execPath, args: [compiledWorker] };
}

function isPragmaTableInfo(sql: string): boolean {
  return /^PRAGMA\s+table_info\s*\(/i.test(sql.trim());
}

function isPragmaIndexList(sql: string): boolean {
  return /^PRAGMA\s+index_list\s*\(/i.test(sql.trim());
}

function extractPragmaTable(sql: string, pragma: "table_info" | "index_list"): string {
  const match = sql.trim().match(new RegExp(`^PRAGMA\\s+${pragma}\\s*\\(\\s*['"]?([A-Za-z0-9_]+)['"]?\\s*\\)`, "i"));
  if (!match) throw new Error(`Unsupported PostgreSQL pragma compatibility query: ${sql}`);
  return match[1];
}

export function translateSqlForPostgres(sql: string): string {
  return sql
    .replace(/^\s*PRAGMA\s+journal_mode\s*=\s*WAL\s*;\s*$/gim, "")
    .replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON\s*;\s*$/gim, "")
    .replace(
      /json_extract\(\s*([A-Za-z0-9_."']+)\s*,\s*'\$\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)'\s*\)/g,
      (_match, column: string, path: string) => `(${column}::jsonb #>> '{${path.split(".").join(",")}}')`
    )
    .replace(/json_extract\(\s*([A-Za-z0-9_."']+)\s*,\s*'\$\.([A-Za-z0-9_]+)'\s*\)/g, "($1::jsonb ->> '$2')");
}

function createCleanDevDataBackup(input: { artifactRoot: string; backupRoot: string; timestamp: string }) {
  const safeTimestamp = input.timestamp.replace(/[^0-9A-Za-z_.-]+/g, "-");
  const backupDir = join(input.backupRoot, `clean-dev-data-${safeTimestamp}`);
  mkdirSync(backupDir, { recursive: true });

  const databaseBackups = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
    .filter((path) => existsSync(path))
    .map((path) => {
      const destination = join(backupDir, basename(path));
      copyFileSync(path, destination);
      return destination;
    });

  const artifactManifest = join(backupDir, "artifacts-manifest.json");
  writeFileSync(
    artifactManifest,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        artifactRoot: input.artifactRoot,
        exists: existsSync(input.artifactRoot),
        entries: listArtifactEntries(input.artifactRoot)
      },
      null,
      2
    )}\n`
  );

  return { backupDir, artifactManifest, databaseBackups };
}

function listArtifactEntries(root: string): Array<{ path: string; type: "file" | "directory"; sizeBytes: number; modifiedAt: string }> {
  if (!existsSync(root)) return [];
  const entries: Array<{ path: string; type: "file" | "directory"; sizeBytes: number; modifiedAt: string }> = [];
  const visit = (path: string) => {
    const stat = statSync(path);
    entries.push({
      path: relative(root, path) || ".",
      type: stat.isDirectory() ? "directory" : "file",
      sizeBytes: stat.isFile() ? stat.size : 0,
      modifiedAt: stat.mtime.toISOString()
    });
    if (!stat.isDirectory()) return;
    for (const entry of readdirSync(path)) {
      visit(join(path, entry));
    }
  };
  visit(root);
  return entries;
}

import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(moduleDir, "schema.sql");
const defaultDbPath = resolve(process.cwd(), "data", "automation-os.sqlite");
const postgresUrl = process.env.AUTOMATION_OS_DATABASE_URL ?? process.env.DATABASE_URL;
const postgresWorkerTimeoutMs = Number(process.env.AUTOMATION_OS_POSTGRES_WORKER_TIMEOUT_MS ?? 12000);

export const dbPath = process.env.AUTOMATION_OS_DB ?? defaultDbPath;
export const dbBackend = postgresUrl ? "postgres" : "sqlite";

export type SqlValue = string | number | boolean | null | undefined | object | unknown[];

let dbInitialized = false;
let dbInitializing = false;
let dbInitRunCount = 0;
let dbConnection: Database.Database | undefined;

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

export function initDb(): void {
  if (dbInitialized) return;
  if (dbBackend === "postgres" && process.env.AUTOMATION_OS_ASSUME_EXISTING_POSTGRES_SCHEMA === "1") {
    dbInitialized = true;
    dbInitRunCount += 1;
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
    execSql(readFileSync(schemaPath, "utf8"));
    runIdempotentMigrations();
    dbInitialized = true;
    dbInitRunCount += 1;
  } finally {
    dbInitializing = false;
  }
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
  ensureColumn("lanes", "browser_use_session", "TEXT");
  ensureColumn("lanes", "browser_use_cdp_url", "TEXT");
  ensureColumn("lanes", "browser_use_profile", "TEXT");
  ensureColumn("lanes", "profile_strategy", "TEXT NOT NULL DEFAULT 'cdp_profile_lane'");
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
  ensureColumn("create_sessions", "title", "TEXT NOT NULL DEFAULT '作る相談'");
  ensureColumn("create_sessions", "messages_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("create_sessions", "draft_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn("create_sessions", "research_sources_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn("create_sessions", "command", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("create_sessions", "created_at", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("create_sessions", "updated_at", "TEXT NOT NULL DEFAULT ''");
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
  `);
  normalizeLaneDefaults();
}

function normalizeLaneDefaults(): void {
  execSql(`
    UPDATE lanes
    SET profile_strategy='cdp_profile_lane'
    WHERE profile_strategy IS NULL OR trim(profile_strategy)='';

    UPDATE lanes
    SET lane_visibility='visible'
    WHERE lane_visibility IS NULL OR trim(lane_visibility)='';
  `);
}

function ensureColumn(table: string, column: string, definition: string): void {
  const columns = listTableColumns(table);
  if (columns.has(column)) return;
  execSql(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
}

function listTableColumns(table: string): Set<string> {
  if (dbBackend === "postgres") {
    const rows = queryPostgresSql(
      `SELECT column_name AS name FROM information_schema.columns WHERE table_schema='public' AND table_name=${sqlValue(table)} ORDER BY ordinal_position;`
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
  const columns = Object.keys(row);
  const values = columns.map((column) => sqlValue(row[column]));
  execSql(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${values.join(", ")});`);
}

export function upsert(table: string, row: Record<string, SqlValue>, conflictColumn = "id"): void {
  const columns = Object.keys(row);
  const values = columns.map((column) => sqlValue(row[column]));
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
    DELETE FROM proofs;
    DELETE FROM approvals;
    DELETE FROM run_steps;
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
      `SELECT column_name AS name FROM information_schema.columns WHERE table_schema='public' AND table_name=${sqlValue(table)} ORDER BY ordinal_position;`
    );
  }
  if (isPragmaIndexList(sql)) {
    const table = extractPragmaTable(sql, "index_list");
    return runPostgresWorker("query", `SELECT indexname AS name FROM pg_indexes WHERE schemaname='public' AND tablename=${sqlValue(table)} ORDER BY indexname;`);
  }
  return runPostgresWorker("query", translateSqlForPostgres(sql));
}

function queryPostgresSqlBatch(sqls: string[]): Array<Array<Record<string, unknown>>> {
  return runPostgresWorkerBatch(sqls.map((sql) => translateSqlForPostgres(sql)));
}

function runPostgresWorker(operation: "exec" | "query", sql: string): Array<Record<string, unknown>> {
  if (!postgresUrl) throw new Error("PostgreSQL backend selected but DATABASE_URL/AUTOMATION_OS_DATABASE_URL is missing");
  const command = resolvePostgresWorkerCommand();
  const stdout = execFileSync(command.bin, command.args, {
    cwd: process.cwd(),
    env: { ...process.env, AUTOMATION_OS_POSTGRES_URL: postgresUrl },
    input: `${JSON.stringify({ operation, sql: translateSqlForPostgres(sql) })}\n`,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    timeout: postgresWorkerTimeoutMs
  });
  const parsed = JSON.parse(stdout) as { ok: boolean; rows?: Array<Record<string, unknown>>; error?: string };
  if (!parsed.ok) throw new Error(parsed.error ?? "PostgreSQL worker failed");
  return parsed.rows ?? [];
}

function runPostgresWorkerBatch(sqls: string[]): Array<Array<Record<string, unknown>>> {
  if (!postgresUrl) throw new Error("PostgreSQL backend selected but DATABASE_URL/AUTOMATION_OS_DATABASE_URL is missing");
  const command = resolvePostgresWorkerCommand();
  const stdout = execFileSync(command.bin, command.args, {
    cwd: process.cwd(),
    env: { ...process.env, AUTOMATION_OS_POSTGRES_URL: postgresUrl },
    input: `${JSON.stringify({ operation: "batchQuery", sqls })}\n`,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    timeout: postgresWorkerTimeoutMs
  });
  const parsed = JSON.parse(stdout) as { ok: boolean; batches?: Array<Array<Record<string, unknown>>>; error?: string };
  if (!parsed.ok) throw new Error(parsed.error ?? "PostgreSQL worker failed");
  return parsed.batches ?? [];
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

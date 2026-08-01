#!/usr/bin/env node
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

const sqlitePath = process.env.AUTOMATION_OS_SQLITE_SOURCE ?? process.env.AUTOMATION_OS_DB ?? resolve(process.cwd(), "data", "automation-os.sqlite");
const postgresUrl = process.env.AUTOMATION_OS_DATABASE_URL ?? process.env.DATABASE_URL;
const confirmed = process.env.AUTOMATION_OS_CONFIRM_POSTGRES_MIGRATION === "1";

const tables = [
  "users",
  "companies",
  "company_memberships",
  "company_audit_events",
  "runs",
  "run_steps",
  "lanes",
  "approvals",
  "proofs",
  "child_runs",
  "worker_events",
  "advisor_events",
  "codex_assets",
  "skills",
  "stored_secrets",
  "system_checks",
  "bridge_actions",
  "bridge_executions",
  "mvp_feedback",
  "mvp_automations",
  "mvp_automation_versions",
  "mvp_automation_schedules",
  "durable_schedule_occurrences",
  "durable_concurrency_slots",
  "durable_jobs",
  "durable_job_attempts",
  "run_artifacts",
  "service_readiness_effect_ledger",
  "feedback_artifacts",
  "mvp_idempotency_keys",
  "company_memory_entries",
  "company_connection_account_refs",
  "knowledge_notes",
  "registered_workflows",
  "research_plans",
  "create_sessions",
  "create_planner_jobs"
];

if (!postgresUrl) {
  console.error("DATABASE_URL or AUTOMATION_OS_DATABASE_URL is required.");
  process.exit(1);
}

if (!confirmed) {
  console.error("Refusing to write PostgreSQL without AUTOMATION_OS_CONFIRM_POSTGRES_MIGRATION=1.");
  console.error("This script creates missing tables and replaces rows in the target PostgreSQL tables.");
  process.exit(1);
}

function translateSchema(sql) {
  return sql
    .replace(/^\s*PRAGMA\s+journal_mode\s*=\s*WAL\s*;\s*$/gim, "")
    .replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON\s*;\s*$/gim, "");
}

function quoteIdent(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function placeholders(count, offset = 0) {
  return Array.from({ length: count }, (_, index) => `$${index + 1 + offset}`).join(", ");
}

function postgresTypeForSqlite(type) {
  const normalized = String(type ?? "").trim().toUpperCase();
  if (normalized.includes("INT")) return "INTEGER";
  if (normalized.includes("REAL") || normalized.includes("FLOA") || normalized.includes("DOUB")) return "DOUBLE PRECISION";
  if (normalized.includes("BLOB")) return "BYTEA";
  if (normalized.includes("BOOL")) return "BOOLEAN";
  return "TEXT";
}

function safePostgresDefault(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  if (/^(?:NULL|TRUE|FALSE|CURRENT_TIMESTAMP|-?\d+(?:\.\d+)?|'(?:[^']|'')*')$/i.test(normalized)) return normalized;
  throw new Error(`postgres_schema_reconcile_unsupported_default:${normalized}`);
}

async function listExistingTargetTables() {
  const result = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE'"
  );
  return new Set(result.rows.map((row) => row.table_name));
}

async function reconcileExistingTargetColumns(table) {
  const sourceColumns = sqlite.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all();
  if (sourceColumns.length === 0) throw new Error(`sqlite_source_table_missing:${table}`);
  const targetResult = await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1",
    [table]
  );
  const targetColumns = new Set(targetResult.rows.map((row) => row.column_name));
  for (const column of sourceColumns) {
    if (targetColumns.has(column.name)) continue;
    const defaultValue = safePostgresDefault(column.dflt_value);
    const definition = [
      postgresTypeForSqlite(column.type),
      defaultValue === null ? "" : `DEFAULT ${defaultValue}`,
      column.notnull || column.pk ? "NOT NULL" : "",
      column.pk ? "PRIMARY KEY" : ""
    ].filter(Boolean).join(" ");
    await client.query(`ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${quoteIdent(column.name)} ${definition}`);
  }
}

const sqlite = new Database(sqlitePath, { readonly: true });
const client = new pg.Client({ connectionString: postgresUrl });
await client.connect();

try {
  const schema = translateSchema(readFileSync(resolve(process.cwd(), "apps", "server", "src", "db", "schema.sql"), "utf8"));
  await client.query("BEGIN");
  const preexistingTables = await listExistingTargetTables();

  // Empty existing owned tables first so missing NOT NULL columns can be added safely.
  // The transaction is rolled back in full if schema reconciliation or copy fails.
  for (const table of [...tables].reverse()) {
    if (preexistingTables.has(table)) await client.query(`DELETE FROM ${quoteIdent(table)};`);
  }
  for (const table of tables) {
    if (preexistingTables.has(table)) await reconcileExistingTargetColumns(table);
  }

  // Existing columns now satisfy indexes and constraints referenced by the current schema;
  // tables absent from the target are created here.
  await client.query(schema);

  for (const table of [...tables].reverse()) {
    await client.query(`DELETE FROM ${quoteIdent(table)};`);
  }

  const copied = [];
  for (const table of tables) {
    const rows = sqlite.prepare(`SELECT * FROM ${quoteIdent(table)}`).all();
    if (rows.length === 0) {
      copied.push({ table, rows: 0 });
      continue;
    }
    const columns = Object.keys(rows[0]);
    const sql = `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(", ")}) VALUES (${placeholders(columns.length)})`;
    for (const row of rows) {
      await client.query(sql, columns.map((column) => row[column]));
    }
    copied.push({ table, rows: rows.length });
  }

  await client.query("COMMIT");
  console.log(
    JSON.stringify(
      {
        ok: true,
        sqliteSource: sqlitePath,
        target: "postgres",
        copied,
        totalRows: copied.reduce((sum, item) => sum + item.rows, 0)
      },
      null,
      2
    )
  );
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  sqlite.close();
  await client.end();
}

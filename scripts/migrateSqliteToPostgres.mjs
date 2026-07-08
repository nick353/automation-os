#!/usr/bin/env node
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

const sqlitePath = process.env.AUTOMATION_OS_SQLITE_SOURCE ?? process.env.AUTOMATION_OS_DB ?? resolve(process.cwd(), "data", "automation-os.sqlite");
const postgresUrl = process.env.AUTOMATION_OS_DATABASE_URL ?? process.env.DATABASE_URL;
const confirmed = process.env.AUTOMATION_OS_CONFIRM_POSTGRES_MIGRATION === "1";

const tables = [
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
  "knowledge_notes",
  "registered_workflows",
  "research_plans"
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

const sqlite = new Database(sqlitePath, { readonly: true });
const client = new pg.Client({ connectionString: postgresUrl });
await client.connect();

try {
  const schema = translateSchema(readFileSync(resolve(process.cwd(), "apps", "server", "src", "db", "schema.sql"), "utf8"));
  await client.query("BEGIN");
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

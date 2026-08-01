import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { translateSqlForPostgres } from "../db/client.js";

test("PostgreSQL schema introspection follows the active search_path schema", () => {
  const source = readFileSync(resolve(process.cwd(), "apps", "server", "src", "db", "client.ts"), "utf8");
  const workerSource = readFileSync(resolve(process.cwd(), "apps", "server", "src", "db", "postgresWorker.ts"), "utf8");
  assert.doesNotMatch(source, /(?:table_schema|schemaname)\s*=\s*['"]public['"]/u);
  assert.match(source, /table_schema=current_schema\(\)/u);
  assert.match(source, /schemaname=current_schema\(\)/u);
  assert.match(source, /ADD COLUMN IF NOT EXISTS/u);
  assert.match(source, /qualifiedPostgresTable\(table\)/u);
  assert.match(workerSource, /pg_advisory_lock/u);
  assert.doesNotMatch(source, /ON CONFLICT\(automation_id, revision\) DO NOTHING/u);
});

test("PostgreSQL SQL translation strips SQLite pragmas from schema batches", () => {
  const translated = translateSqlForPostgres(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
  `);

  assert.doesNotMatch(translated, /PRAGMA/i);
  assert.match(translated, /CREATE TABLE IF NOT EXISTS runs/);
});

test("PostgreSQL SQL translation maps json_extract text reads to jsonb operators", () => {
  const translated = translateSqlForPostgres(`
    SELECT
      COALESCE(
        NULLIF(trim(json_extract(runs.metadata_json, '$.registeredWorkflowId')), ''),
        NULLIF(trim(json_extract(runs.metadata_json, '$.workflow_id')), '')
      ) AS workflow_key
    FROM runs;
  `);

  assert.match(translated, /\(runs\.metadata_json::jsonb ->> 'registeredWorkflowId'\)/);
  assert.match(translated, /\(runs\.metadata_json::jsonb ->> 'workflow_id'\)/);
  assert.doesNotMatch(translated, /json_extract/);
});

test("PostgreSQL SQL translation maps nested json_extract paths without leaving SQLite functions", () => {
  const translated = translateSqlForPostgres(`
    SELECT id
    FROM runs
    WHERE json_extract(metadata_json, '$.scheduler_service_identity.scope')='global_system';
  `);

  assert.match(translated, /\(metadata_json::jsonb #>> '\{scheduler_service_identity,scope\}'\)/);
  assert.doesNotMatch(translated, /json_extract/);
});

test("PostgreSQL SQL translation keeps the automation versioning schema batch intact", () => {
  const translated = translateSqlForPostgres(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS mvp_automations (
      id TEXT PRIMARY KEY,
      current_version_id TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      archived_at TEXT
    );
    CREATE TABLE IF NOT EXISTS mvp_automation_versions (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL REFERENCES mvp_automations(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS mvp_automation_schedules (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL REFERENCES mvp_automations(id) ON DELETE CASCADE,
      automation_version_id TEXT REFERENCES mvp_automation_versions(id) ON DELETE SET NULL
    );
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
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(company_id, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS durable_job_attempts (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL REFERENCES durable_jobs(id) ON DELETE CASCADE,
      attempt_no INTEGER NOT NULL,
      service_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      fencing_token INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      finished_at TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(job_id, attempt_no)
    );
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
    CREATE TABLE IF NOT EXISTS mvp_idempotency_keys (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL,
      idempotency_key TEXT NOT NULL
    );
  `);

  assert.doesNotMatch(translated, /PRAGMA/i);
  assert.match(translated, /CREATE TABLE IF NOT EXISTS mvp_automations/);
  assert.match(translated, /current_version_id TEXT/);
  assert.match(translated, /CREATE TABLE IF NOT EXISTS mvp_automation_versions/);
  assert.match(translated, /CREATE TABLE IF NOT EXISTS mvp_automation_schedules/);
  assert.match(translated, /CREATE TABLE IF NOT EXISTS durable_schedule_occurrences/);
  assert.match(translated, /CREATE TABLE IF NOT EXISTS durable_concurrency_slots/);
  assert.match(translated, /CREATE TABLE IF NOT EXISTS durable_jobs/);
  assert.match(translated, /CREATE TABLE IF NOT EXISTS durable_job_attempts/);
  assert.match(translated, /CREATE TABLE IF NOT EXISTS run_artifacts/);
  assert.match(translated, /CREATE TABLE IF NOT EXISTS mvp_idempotency_keys/);
});

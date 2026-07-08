import assert from "node:assert/strict";
import test from "node:test";
import { translateSqlForPostgres } from "../db/client.js";

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

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-db-migrations-"));
const legacyDbPath = join(tempRoot, "automation-os.sqlite");
process.env.AUTOMATION_OS_DB = legacyDbPath;

const db = await import("../db/client.js");

test("initDb adds Browser Use lane columns to an existing lanes table", () => {
  mkdirSync(dirname(legacyDbPath), { recursive: true });
  const legacySchema = `
    CREATE TABLE lanes (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      role TEXT NOT NULL,
      cdp_port INTEGER NOT NULL,
      profile_dir TEXT NOT NULL,
      workdir TEXT NOT NULL,
      status TEXT NOT NULL,
      current_task TEXT,
      progress INTEGER NOT NULL DEFAULT 0,
      health TEXT NOT NULL DEFAULT 'good',
      resource_locks_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    );
    INSERT INTO lanes (id, run_id, role, cdp_port, profile_dir, workdir, status, current_task, progress, health, resource_locks_json, updated_at)
    VALUES ('lane_legacy', 'run_legacy', 'browser', 9333, '/tmp/profile', '/tmp/workdir', 'active', 'legacy', 10, 'good', '[]', '2026-06-11T00:00:00.000Z');
  `;
  const created = spawnSync("sqlite3", [legacyDbPath], { input: legacySchema, encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);

  db.initDb();
  db.initDb();

  const columns = db.querySql<{ name: string }>("PRAGMA table_info(lanes)").map((row) => row.name);
  assert.ok(columns.includes("browser_use_session"));
  assert.ok(columns.includes("browser_use_cdp_url"));
  assert.ok(columns.includes("browser_use_profile"));
  assert.ok(columns.includes("profile_strategy"));
  assert.ok(columns.includes("lane_visibility"));

  const legacyLane = db.querySql<{ profile_strategy: string; lane_visibility: string }>("SELECT profile_strategy, lane_visibility FROM lanes WHERE id='lane_legacy'")[0];
  assert.equal(legacyLane.profile_strategy, "cdp_profile_lane");
  assert.equal(legacyLane.lane_visibility, "visible");

  const childColumns = db.querySql<{ name: string }>("PRAGMA table_info(child_runs)").map((row) => row.name);
  assert.ok(childColumns.includes("parent_run_id"));
  assert.ok(childColumns.includes("step_id"));
  assert.ok(childColumns.includes("prompt_uri"));
  assert.ok(childColumns.includes("result_uri"));
  assert.ok(childColumns.includes("metadata_json"));

  const childIndexes = db.querySql<{ name: string }>("PRAGMA index_list(child_runs)").map((row) => row.name);
  assert.ok(childIndexes.includes("idx_child_runs_parent"));
  assert.ok(childIndexes.includes("idx_child_runs_step"));
});

test("initDb backfills empty Browser Use lane defaults when columns already exist", () => {
  db.execSql(`
    DROP TABLE lanes;
    CREATE TABLE lanes (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      role TEXT NOT NULL,
      cdp_port INTEGER NOT NULL,
      profile_dir TEXT NOT NULL,
      workdir TEXT NOT NULL,
      browser_use_session TEXT,
      browser_use_cdp_url TEXT,
      browser_use_profile TEXT,
      profile_strategy TEXT,
      lane_visibility TEXT,
      status TEXT NOT NULL,
      current_task TEXT,
      progress INTEGER NOT NULL DEFAULT 0,
      health TEXT NOT NULL DEFAULT 'good',
      resource_locks_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    );
    INSERT INTO lanes (
      id, run_id, role, cdp_port, profile_dir, workdir,
      browser_use_session, browser_use_cdp_url, browser_use_profile,
      profile_strategy, lane_visibility, status, current_task, progress, health, resource_locks_json, updated_at
    )
    VALUES
      ('lane_null_defaults', 'run_null', 'browser', 9333, '/tmp/profile-null', '/tmp/workdir-null', NULL, NULL, NULL, NULL, NULL, 'idle', 'legacy', 0, 'good', '[]', '2026-06-11T01:00:00.000Z'),
      ('lane_empty_defaults', 'run_empty', 'browser', 9334, '/tmp/profile-empty', '/tmp/workdir-empty', NULL, NULL, NULL, '', '   ', 'idle', 'legacy', 0, 'good', '[]', '2026-06-11T01:01:00.000Z');
  `);

  db.initDb();

  const lanes = db.querySql<{ id: string; profile_strategy: string; lane_visibility: string }>(
    "SELECT id, profile_strategy, lane_visibility FROM lanes ORDER BY id"
  );
  assert.deepEqual(lanes, [
    { id: "lane_empty_defaults", profile_strategy: "cdp_profile_lane", lane_visibility: "visible" },
    { id: "lane_null_defaults", profile_strategy: "cdp_profile_lane", lane_visibility: "visible" }
  ]);
});

test("initDb adds Research Planner JSON columns to an existing research_plans table", () => {
  db.execSql(`
    DROP TABLE research_plans;
    CREATE TABLE research_plans (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      command TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO research_plans (id, title, status, command, created_at, updated_at)
    VALUES ('research_plan_legacy', 'Legacy', 'planned', 'legacy command', '2026-06-16T00:00:00.000Z', '2026-06-16T00:00:00.000Z');
  `);

  db.initDb();

  const columns = db.querySql<{ name: string }>("PRAGMA table_info(research_plans)").map((row) => row.name);
  assert.ok(columns.includes("sources_json"));
  assert.ok(columns.includes("visible_flow_json"));
  assert.ok(columns.includes("source_of_truth_json"));
  assert.ok(columns.includes("proof_boundary_json"));
  assert.ok(columns.includes("approval_boundary_json"));
  assert.ok(columns.includes("metadata_json"));
  assert.ok(columns.includes("demo_check_id"));
  assert.ok(columns.includes("run_id"));

  const row = db.querySql<{ visible_flow_json: string; metadata_json: string }>("SELECT visible_flow_json, metadata_json FROM research_plans WHERE id='research_plan_legacy'")[0];
  assert.equal(row.visible_flow_json, "[]");
  assert.equal(row.metadata_json, "{}");
});

test("querySql reuses completed initDb until a schema-changing execSql invalidates it", () => {
  db.initDb();
  const afterExplicitInit = db.getDbInitDiagnostics();

  assert.equal(afterExplicitInit.initialized, true);
  assert.equal(afterExplicitInit.initializing, false);

  assert.deepEqual(db.querySql<{ value: number }>("SELECT 1 AS value"), [{ value: 1 }]);
  assert.deepEqual(db.querySql<{ value: number }>("SELECT 2 AS value"), [{ value: 2 }]);
  const afterRepeatedQueries = db.getDbInitDiagnostics();

  assert.equal(afterRepeatedQueries.runCount, afterExplicitInit.runCount);

  db.execSql("CREATE TABLE IF NOT EXISTS init_cache_probe (id TEXT PRIMARY KEY);");
  const afterSchemaChange = db.getDbInitDiagnostics();

  assert.equal(afterSchemaChange.initialized, false);

  assert.deepEqual(db.querySql<{ value: number }>("SELECT 3 AS value"), [{ value: 3 }]);
  const afterReinit = db.getDbInitDiagnostics();

  assert.equal(afterReinit.initialized, true);
  assert.equal(afterReinit.runCount, afterRepeatedQueries.runCount + 1);

  assert.deepEqual(db.querySql<{ value: number }>("SELECT 4 AS value"), [{ value: 4 }]);
  assert.equal(db.getDbInitDiagnostics().runCount, afterReinit.runCount);
});

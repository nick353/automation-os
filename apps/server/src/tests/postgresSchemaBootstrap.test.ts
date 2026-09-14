import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

const postgresUrl = process.env.AUTOMATION_OS_TEST_POSTGRES_URL;
if (postgresUrl) process.env.AUTOMATION_OS_DATABASE_URL = postgresUrl;
const db = await import("../db/client.js");

test("PostgreSQL bootstrap handles an empty schema and reruns an existing schema migration", {
  skip: postgresUrl ? false : "postgres_fixture_unavailable",
  timeout: 180_000
}, async () => {
  await db.initializePostgresSchemaAsync();
  const first = (await db.querySqlAsync<{ version: number }>(
    "SELECT version FROM automation_os_schema_bootstrap WHERE id='primary' LIMIT 1"
  ))[0];
  assert.equal(Number(first?.version), db.postgresSchemaBootstrapVersion);

  await db.execSqlAsync(
    `UPDATE automation_os_schema_bootstrap SET version=${db.sqlValue(db.postgresSchemaBootstrapVersion - 1)} WHERE id='primary'`
  );
  const tsx = join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  const rerun = spawnSync(tsx, ["-e", `process.env.AUTOMATION_OS_DATABASE_URL = ${JSON.stringify(postgresUrl)}; (async () => { const db = await import("./apps/server/src/db/client.ts"); await db.initializePostgresSchemaAsync(); })();`], {
    cwd: process.cwd(),
    env: { ...process.env, AUTOMATION_OS_DATABASE_URL: postgresUrl },
    encoding: "utf8"
  });
  assert.equal(rerun.status, 0, `${rerun.stdout}\n${rerun.stderr}`);
  const second = (await db.querySqlAsync<{ version: number }>(
    "SELECT version FROM automation_os_schema_bootstrap WHERE id='primary' LIMIT 1"
  ))[0];
  assert.equal(Number(second?.version), db.postgresSchemaBootstrapVersion);
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import pg from "pg";

const postgresUrl = process.env.AUTOMATION_OS_TEST_POSTGRES_URL ?? "";
const postgresSkipReason = postgresUrl ? undefined : "AUTOMATION_OS_TEST_POSTGRES_URL is not set";

test("real PostgreSQL serializes empty-schema bootstrap and produces exactly one durable claim winner", { skip: postgresSkipReason }, async () => {
  const schema = `automation_os_queue_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Client({ connectionString: postgresUrl });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const scopedUrl = new URL(postgresUrl);
  scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
  process.env.AUTOMATION_OS_DATABASE_URL = scopedUrl.toString();

  try {
    const dbModuleUrl = new URL("../db/client.js", import.meta.url).href;
    const initCode = `
      const db = await import(${JSON.stringify(dbModuleUrl)});
      db.initDb();
      process.stdout.write("initialized");
    `;
    const initialized = await Promise.all(Array.from({ length: 4 }, () => runClaimProcess(initCode, scopedUrl.toString())));
    assert.deepEqual(initialized, ["initialized", "initialized", "initialized", "initialized"]);

    const db = await import("../db/client.js");
    const queue = await import("../runs/durableQueue.js");
    db.initDb();
    const now = "2026-07-15T00:00:00.000Z";
    const companyId = "postgres_claim_company";
    const serviceUserId = "postgres_claim_service";
    const automationId = "postgres_claim_automation";
    const versionId = "postgres_claim_version";
    db.insert("users", { id: serviceUserId, auth_provider: "service", auth_subject: serviceUserId, email: null, display_name: serviceUserId, kind: "service", status: "active", created_at: now, updated_at: now });
    db.insert("companies", { id: companyId, slug: companyId, name: companyId, status: "active", created_at: now, updated_at: now });
    db.insert("company_memberships", { id: "postgres_claim_membership", company_id: companyId, user_id: serviceUserId, role: "operator", status: "active", created_at: now, updated_at: now });
    const automation = { company_id: companyId, project_id: companyId, automation_type: "test", name: "Postgres claim", description: "test", goal: "single claim", schedule: "manual", cadence: "manual", lane: "local", risk_level: "low", approval_policy: "required_before_external_action", worker_command_kind: "safe_local_demo", create_approval: 0, status: "active", builder_spec_json: {}, created_at: now, updated_at: now };
    db.insert("mvp_automations", { id: automationId, ...automation, current_version_id: versionId, revision: 1, archived_at: null });
    db.insert("mvp_automation_versions", { id: versionId, ...automation, automation_id: automationId, revision: 1 });
    const job = queue.enqueueAutomationDryRun({ companyId, actorUserId: serviceUserId, automationId, idempotencyKey: "postgres-claim-once" });
    const claimAt = new Date(Date.parse(job.availableAt) + 1_000).toISOString();

    const moduleUrl = new URL("../runs/durableQueue.js", import.meta.url).href;
    const code = `
      const queue = await import(${JSON.stringify(moduleUrl)});
      const claim = queue.claimNextDurableJob({ companyId: ${JSON.stringify(companyId)}, serviceUserId: ${JSON.stringify(serviceUserId)}, now: ${JSON.stringify(claimAt)} });
      process.stdout.write(claim ? claim.id : "null");
    `;
    const results = await Promise.all(Array.from({ length: 8 }, () => runClaimProcess(code, scopedUrl.toString())));
    assert.deepEqual(results.filter((value) => value === job.id), [job.id]);
    assert.equal(results.filter((value) => value === "null").length, 7);
    assert.equal(db.querySql<{ count: number }>(`SELECT count(*) AS count FROM durable_job_attempts WHERE job_id=${db.sqlValue(job.id)}`)[0].count, 1);
    assert.equal(db.querySql<{ active_count: number }>(`SELECT active_count FROM durable_concurrency_slots WHERE company_id=${db.sqlValue(companyId)} AND concurrency_key=${db.sqlValue(job.concurrencyKey)}`)[0].active_count, 1);
  } finally {
    delete process.env.AUTOMATION_OS_DATABASE_URL;
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});

test("real PostgreSQL initializes a legacy mvp_automation_versions table without UNIQUE(automation_id, revision) after schema marker removal", { skip: postgresSkipReason }, async () => {
  const schema = makePostgresSchemaName("automation_os_pg_legacy_versions");
  const admin = new pg.Client({ connectionString: postgresUrl });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const scopedUrl = new URL(postgresUrl);
  scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
  process.env.AUTOMATION_OS_DATABASE_URL = scopedUrl.toString();

  try {
    await admin.query(`
      CREATE TABLE "${schema}".mvp_automations (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL DEFAULT '',
        project_id TEXT NOT NULL DEFAULT '',
        automation_type TEXT NOT NULL DEFAULT 'test',
        name TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        goal TEXT NOT NULL DEFAULT '',
        schedule TEXT NOT NULL DEFAULT '',
        cadence TEXT NOT NULL DEFAULT '',
        lane TEXT NOT NULL DEFAULT '',
        risk_level TEXT NOT NULL DEFAULT '',
        approval_policy TEXT NOT NULL DEFAULT '',
        worker_command_kind TEXT NOT NULL DEFAULT '',
        create_approval INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'draft',
        builder_spec_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE "${schema}".mvp_automation_versions (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL DEFAULT '',
        project_id TEXT NOT NULL DEFAULT '',
        automation_id TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        automation_type TEXT NOT NULL DEFAULT 'test',
        name TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        goal TEXT NOT NULL DEFAULT '',
        schedule TEXT NOT NULL DEFAULT '',
        cadence TEXT NOT NULL DEFAULT '',
        lane TEXT NOT NULL DEFAULT '',
        risk_level TEXT NOT NULL DEFAULT '',
        approval_policy TEXT NOT NULL DEFAULT '',
        worker_command_kind TEXT NOT NULL DEFAULT '',
        create_approval INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'draft',
        builder_spec_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO "${schema}".mvp_automations (
        id, company_id, project_id, automation_type, name, description, goal, schedule, cadence, lane,
        risk_level, approval_policy, worker_command_kind, create_approval, status, builder_spec_json, created_at, updated_at
      )
      VALUES (
        'legacy_automation', 'legacy_company', 'legacy_project', 'test', 'Legacy automation', 'legacy description', 'legacy goal',
        'manual', 'manual', 'local', 'low', 'required_before_external_action', 'safe_local_demo', 0, 'active', '{}',
        '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z'
      );
    `);

    const dbModuleUrl = new URL("../db/client.js", import.meta.url).href;
    const initCode = `
      const db = await import(${JSON.stringify(dbModuleUrl)});
      db.initDb();
      const version = db.querySql(\`
        SELECT id, automation_id, revision
        FROM mvp_automation_versions
        WHERE automation_id='legacy_automation'
        ORDER BY revision
      \`);
      const current = db.querySql(\`
        SELECT current_version_id, revision
        FROM mvp_automations
        WHERE id='legacy_automation'
      \`);
      process.stdout.write(JSON.stringify({ version, current }));
    `;
    const result = await runClaimProcess(initCode, scopedUrl.toString());
    const parsed = JSON.parse(result) as {
      version: Array<{ id: string; automation_id: string; revision: number }>;
      current: Array<{ current_version_id: string | null; revision: number }>;
    };

    assert.deepEqual(parsed.version, [
      { id: "mvpav_legacy_automation_v1", automation_id: "legacy_automation", revision: 1 }
    ]);
    assert.deepEqual(parsed.current, [
      { current_version_id: "mvpav_legacy_automation_v1", revision: 1 }
    ]);
  } finally {
    delete process.env.AUTOMATION_OS_DATABASE_URL;
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});

test("real PostgreSQL initialization only alters the first search_path schema and leaves a task-owned fallback users table untouched", { skip: postgresSkipReason }, async () => {
  const tenantSchema = makePostgresSchemaName("automation_os_pg_tenant_users");
  const fallbackSchema = makePostgresSchemaName("automation_os_pg_fallback_users");
  const admin = new pg.Client({ connectionString: postgresUrl });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${tenantSchema}"`);
  await admin.query(`CREATE SCHEMA "${fallbackSchema}"`);
  const scopedUrl = new URL(postgresUrl);
  scopedUrl.searchParams.set("options", `-c search_path=${tenantSchema},${fallbackSchema}`);
  process.env.AUTOMATION_OS_DATABASE_URL = scopedUrl.toString();

  try {
    await admin.query(`
      CREATE TABLE "${tenantSchema}".users (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO "${tenantSchema}".users (id, display_name, created_at, updated_at)
      VALUES ('tenant-user', 'Tenant User', '2026-07-15T01:00:00.000Z', '2026-07-15T01:00:00.000Z');

      CREATE TABLE "${fallbackSchema}".users (
        id TEXT PRIMARY KEY,
        sentinel_marker TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO "${fallbackSchema}".users (id, sentinel_marker, created_at, updated_at)
      VALUES ('public-sentinel', 'stay-put', '2026-07-15T01:00:00.000Z', '2026-07-15T01:00:00.000Z');
    `);

    const dbModuleUrl = new URL("../db/client.js", import.meta.url).href;
    const initCode = `
      const db = await import(${JSON.stringify(dbModuleUrl)});
      db.initDb();
      const tenantUsers = db.querySql(\`
        SELECT id, auth_provider, auth_subject, display_name
        FROM users
        ORDER BY id
      \`);
      const publicUsers = db.querySql(\`
        SELECT column_name AS name
        FROM information_schema.columns
        WHERE table_schema='${fallbackSchema}' AND table_name='users'
        ORDER BY ordinal_position
      \`);
      const publicSentinel = db.querySql(\`
        SELECT id, sentinel_marker
        FROM "${fallbackSchema}".users
        ORDER BY id
      \`);
      process.stdout.write(JSON.stringify({ tenantUsers, publicUsers, publicSentinel }));
    `;
    const result = await runClaimProcess(initCode, scopedUrl.toString());
    const parsed = JSON.parse(result) as {
      tenantUsers: Array<{ id: string; auth_provider: string; auth_subject: string; display_name: string }>;
      publicUsers: Array<{ name: string }>;
      publicSentinel: Array<{ id: string; sentinel_marker: string }>;
    };

    assert.deepEqual(parsed.tenantUsers, [
      {
        id: "tenant-user",
        auth_provider: "legacy_operator_token",
        auth_subject: "",
        display_name: "Tenant User"
      }
    ]);
    assert.deepEqual(parsed.publicUsers.map((row) => row.name), ["id", "sentinel_marker", "created_at", "updated_at"]);
    assert.deepEqual(parsed.publicSentinel, [
      { id: "public-sentinel", sentinel_marker: "stay-put" }
    ]);
  } finally {
    delete process.env.AUTOMATION_OS_DATABASE_URL;
    await admin.query(`DROP SCHEMA IF EXISTS "${tenantSchema}" CASCADE`);
    await admin.query(`DROP SCHEMA IF EXISTS "${fallbackSchema}" CASCADE`);
    await admin.end();
  }
});

test("real PostgreSQL initialization fails closed when the schema marker version is newer than the binary", { skip: postgresSkipReason }, async () => {
  const schema = makePostgresSchemaName("automation_os_pg_newer_marker");
  const admin = new pg.Client({ connectionString: postgresUrl });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const scopedUrl = new URL(postgresUrl);
  scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
  process.env.AUTOMATION_OS_DATABASE_URL = scopedUrl.toString();

  try {
    const { postgresSchemaBootstrapVersion } = await import("../db/client.js");
    const newerSchemaVersion = postgresSchemaBootstrapVersion + 1;
    await admin.query(`
      CREATE TABLE "${schema}".automation_os_schema_bootstrap (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO "${schema}".automation_os_schema_bootstrap (id, version, updated_at)
      VALUES ('primary', ${newerSchemaVersion}, '2026-07-15T02:00:00.000Z');
    `);

    const dbModuleUrl = new URL("../db/client.js", import.meta.url).href;
    const initCode = `
      try {
        const db = await import(${JSON.stringify(dbModuleUrl)});
        db.initDb();
        process.stdout.write("initialized");
      } catch (error) {
        process.stdout.write(error instanceof Error ? error.message : String(error));
      }
    `;
    const result = await runClaimProcess(initCode, scopedUrl.toString());
    assert.equal(result, `postgres_schema_version_newer_than_binary:${newerSchemaVersion}:${postgresSchemaBootstrapVersion}`);
  } finally {
    delete process.env.AUTOMATION_OS_DATABASE_URL;
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});

test("real PostgreSQL rolls back a transaction when the server drops its connection", { skip: postgresSkipReason }, async () => {
  const schema = makePostgresSchemaName("automation_os_pg_connection_drop");
  const admin = new pg.Client({ connectionString: postgresUrl });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.query(`CREATE TABLE "${schema}".connection_drop_probe (id INTEGER PRIMARY KEY)`);
  const scopedUrl = new URL(postgresUrl);
  scopedUrl.searchParams.set("options", `-c search_path=${schema}`);

  try {
    const dbModuleUrl = new URL("../db/client.js", import.meta.url).href;
    const transactionCode = `
      try {
        const db = await import(${JSON.stringify(dbModuleUrl)});
        db.runSqlTransaction([
          { sql: "INSERT INTO connection_drop_probe (id) VALUES (1)", expectChanges: 1 },
          { sql: "SELECT pg_terminate_backend(pg_backend_pid())" }
        ]);
        process.stdout.write("unexpected-success");
      } catch (error) {
        process.stdout.write(error instanceof Error ? error.message : String(error));
      }
    `;
    const result = await runClaimProcess(transactionCode, scopedUrl.toString());
    assert.match(result, /Connection terminated unexpectedly|terminating connection|server closed|connection.*lost|PostgreSQL/i);
    const rows = await admin.query(`SELECT count(*)::INTEGER AS count FROM "${schema}".connection_drop_probe`);
    assert.equal(Number(rows.rows[0]?.count), 0);
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});

function runClaimProcess(code: string, databaseUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", code], {
      cwd: process.cwd(),
      env: { ...process.env, AUTOMATION_OS_DATABASE_URL: databaseUrl },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (codeValue) => codeValue === 0 ? resolve(stdout.trim()) : reject(new Error(`postgres_claim_process_failed:${codeValue}:${stderr.trim()}`)));
  });
}

function makePostgresSchemaName(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

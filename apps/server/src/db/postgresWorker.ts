import pg from "pg";

type WorkerInput = {
  operation: "exec" | "query";
  sql: string;
} | {
  operation: "batchQuery";
  sqls: string[];
} | {
  operation: "transaction";
  steps: Array<{ sql: string; expectChanges?: number }>;
} | {
  operation: "initialize";
  bootstrapVersion: number;
};

const { Client, types } = pg;
const trace = process.env.AUTOMATION_OS_POSTGRES_WORKER_TRACE === "1";
const timeoutMs = Number(process.env.AUTOMATION_OS_POSTGRES_WORKER_TIMEOUT_MS ?? 12000);
let responseWritten = false;

types.setTypeParser(20, (value) => Number(value));
types.setTypeParser(21, (value) => Number(value));
types.setTypeParser(23, (value) => Number(value));
types.setTypeParser(700, (value) => Number(value));
types.setTypeParser(701, (value) => Number(value));

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      text += chunk;
    });
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", reject);
  });
}

function writeResult(result: { ok: true; rows?: Array<Record<string, unknown>>; batches?: Array<Array<Record<string, unknown>>> } | { ok: false; error: string }) {
  if (responseWritten) return;
  responseWritten = true;
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try {
  if (trace) console.error("postgresWorker: start");
  const databaseUrl = process.env.AUTOMATION_OS_POSTGRES_URL;
  if (!databaseUrl) throw new Error("AUTOMATION_OS_POSTGRES_URL is missing");
  const hardTimeout = setTimeout(() => {
    writeResult({ ok: false, error: `PostgreSQL worker timed out after ${timeoutMs}ms` });
    process.exit(124);
  }, timeoutMs + 1000);
  hardTimeout.unref();
  const input = JSON.parse(await readStdin()) as WorkerInput;
  const inputPreview = input.operation === "initialize"
    ? "schema bootstrap"
    : input.operation === "batchQuery"
    ? `${input.sqls.length} statements`
    : input.operation === "transaction"
      ? `${input.steps.length} transaction steps`
      : input.sql.slice(0, 240).replace(/\s+/g, " ");
  if (trace) console.error(`postgresWorker: input ${input.operation} ${inputPreview}`);
  if (input.operation !== "exec" && input.operation !== "query" && input.operation !== "batchQuery" && input.operation !== "transaction" && input.operation !== "initialize") {
    throw new Error(`Unsupported PostgreSQL operation: ${String(input.operation)}`);
  }

  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
    statement_timeout: timeoutMs
  });
  if (trace) console.error("postgresWorker: connecting");
  await client.connect();
  if (trace) console.error("postgresWorker: connected");
  try {
    if (trace) console.error("postgresWorker: querying");
    if (input.operation === "initialize") {
      if (!Number.isSafeInteger(input.bootstrapVersion) || input.bootstrapVersion < 1) {
        throw new Error("postgres_schema_bootstrap_version_invalid");
      }
      await client.query("SELECT pg_advisory_lock(hashtext('automation_os_schema_bootstrap'))");
      try {
        const marker = await client.query(`
          SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema=current_schema() AND table_name='automation_os_schema_bootstrap'
          ) AS present
        `);
        let databaseVersion: number | null = null;
        if (marker.rows[0]?.present === true) {
          const version = await client.query("SELECT version FROM automation_os_schema_bootstrap WHERE id='primary' LIMIT 1");
          if (version.rows[0]?.version !== undefined) databaseVersion = Number(version.rows[0].version);
        }
        if (databaseVersion !== null && Number.isFinite(databaseVersion) && databaseVersion > input.bootstrapVersion) {
          throw new Error(`postgres_schema_version_newer_than_binary:${databaseVersion}:${input.bootstrapVersion}`);
        }
        if (databaseVersion !== input.bootstrapVersion) {
          process.env.AUTOMATION_OS_POSTGRES_BOOTSTRAP_LOCK_HELD = "1";
          const database = await import("./client.js");
          if (database.postgresSchemaBootstrapVersion !== input.bootstrapVersion) {
            throw new Error(`postgres_schema_bootstrap_version_mismatch:${database.postgresSchemaBootstrapVersion}:${input.bootstrapVersion}`);
          }
          database.initializePostgresSchemaUnderLock();
        }
        writeResult({ ok: true });
      } finally {
        delete process.env.AUTOMATION_OS_POSTGRES_BOOTSTRAP_LOCK_HELD;
        await client.query("SELECT pg_advisory_unlock(hashtext('automation_os_schema_bootstrap'))");
      }
    } else if (input.operation === "transaction") {
      await client.query("BEGIN");
      try {
        for (const step of input.steps) {
          const result = await client.query(step.sql);
          const changes = Array.isArray(result)
            ? result.reduce((sum, item) => sum + Number(item.rowCount ?? 0), 0)
            : Number(result.rowCount ?? 0);
          if (step.expectChanges !== undefined && changes !== step.expectChanges) {
            throw new Error(`sql_transaction_expected_changes:${step.expectChanges}:actual:${changes}`);
          }
        }
        await client.query("COMMIT");
        if (trace) console.error("postgresWorker: transaction committed");
        writeResult({ ok: true });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    } else if (input.operation === "batchQuery") {
      const batches = [];
      for (const sql of input.sqls) {
        const result = await client.query(sql);
        batches.push(Array.isArray(result) ? result.flatMap((item) => item.rows ?? []) : result.rows);
      }
      if (trace) console.error("postgresWorker: queried");
      writeResult({ ok: true, batches });
    } else {
      const result = await client.query(input.sql);
      if (trace) console.error("postgresWorker: queried");
      if (input.operation === "query") {
        writeResult({ ok: true, rows: Array.isArray(result) ? result.flatMap((item) => item.rows ?? []) : result.rows });
      } else {
        writeResult({ ok: true });
      }
    }
  } finally {
    await client.end();
    clearTimeout(hardTimeout);
  }
} catch (error) {
  if (!responseWritten) {
    writeResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  } else if (trace) {
    console.error("postgresWorker: cleanup after response failed");
  }
}

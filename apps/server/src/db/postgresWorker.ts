import pg from "pg";

type WorkerInput = {
  operation: "exec" | "query";
  sql: string;
} | {
  operation: "batchQuery";
  sqls: string[];
};

const { Client, types } = pg;
const trace = process.env.AUTOMATION_OS_POSTGRES_WORKER_TRACE === "1";
const timeoutMs = Number(process.env.AUTOMATION_OS_POSTGRES_WORKER_TIMEOUT_MS ?? 12000);

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
  const inputPreview = input.operation === "batchQuery" ? `${input.sqls.length} statements` : input.sql.slice(0, 240).replace(/\s+/g, " ");
  if (trace) console.error(`postgresWorker: input ${input.operation} ${inputPreview}`);
  if (input.operation !== "exec" && input.operation !== "query" && input.operation !== "batchQuery") {
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
    if (input.operation === "batchQuery") {
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
  writeResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}

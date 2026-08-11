import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

test("registered automation HTTP read does not run synchronous PostgreSQL initDb", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/server/src/index.ts"), "utf8");
  const routeStart = source.indexOf('app.get("/api/mvp/registered-automations"');
  const routeEnd = source.indexOf('app.post("/api/mvp/registered-automations/:id/run"', routeStart);
  assert.ok(routeStart >= 0);
  assert.ok(routeEnd > routeStart);
  const route = source.slice(routeStart, routeEnd);
  assert.match(route, /if \(dbBackend !== "postgres"\) initDb\(\);/);
  assert.doesNotMatch(route, /try \{\s*initDb\(\);/u);
});

test("async PostgreSQL DB boundary fails closed without a synchronous connection probe", async () => {
  const modulePath = resolve(process.cwd(), "apps/server/dist/db/client.js");
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { querySqlAsync } from ${JSON.stringify(modulePath)};
try {
  await querySqlAsync("SELECT 1;");
  console.log(JSON.stringify({ ok: true }));
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
}`
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AUTOMATION_OS_DATABASE_URL: "postgresql://127.0.0.1:1/automation_os_boundary_test",
        DATABASE_URL: "",
        AUTOMATION_OS_POSTGRES_SCHEMA_ASSUMED_CURRENT: "0",
        AUTOMATION_OS_ALLOW_SQLITE_FALLBACK: "0",
        NODE_TEST_CONTEXT: "1"
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`async_db_boundary_child_timeout:${stderr}`));
    }, 1500);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      assert.equal(signal, null);
      assert.equal(code, 0, stderr);
      resolvePromise();
    });
  });
  assert.deepEqual(JSON.parse(stdout.trim()), { error: "postgres_async_schema_not_ready" });
});

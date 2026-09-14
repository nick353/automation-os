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

test("registered automation readback uses stored rows before async catalog repair", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/server/src/index.ts"), "utf8");
  const helperStart = source.indexOf("async function buildCompanyRegisteredAutomationReadback");
  const helperEnd = source.indexOf("function buildCompanyRegisteredAutomationRunResponse", helperStart);
  assert.ok(helperStart >= 0);
  assert.ok(helperEnd > helperStart);
  const helper = source.slice(helperStart, helperEnd);
  const storedRead = helper.indexOf("let storedWorkflows = await listRegisteredWorkflowsForCompaniesAsync");
  const repair = helper.indexOf("await initRegisteredWorkflowsAsync();", storedRead);
  assert.ok(storedRead >= 0, "stored workflow read missing");
  assert.ok(repair > storedRead, "empty-catalog repair must follow stored read");
  assert.match(helper.slice(storedRead, repair), /if \(storedWorkflows\.length === 0\)/u);
  assert.match(helper, /await buildWebOperationBackendRunSnapshotAsync\(\)/u);
  assert.doesNotMatch(helper, /buildWebOperationBackendRunSnapshot\(\)/u);
});

test("manual registered automation trigger stays on the asynchronous PostgreSQL boundary", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/server/src/index.ts"), "utf8");
  const routeStart = source.indexOf('app.post("/api/v1/companies/:companyId/automations/:automationId/trigger"');
  const routeEnd = source.indexOf("\napp.", routeStart + 1);
  assert.ok(routeStart >= 0);
  assert.ok(routeEnd > routeStart);
  const route = source.slice(routeStart, routeEnd);
  assert.match(route, /const postgres = dbBackend === "postgres"/u);
  assert.match(route, /await requireCompanyAccessAsync\(companyId, \["owner", "admin", "operator"\]\)/u);
  assert.match(route, /await getAutomationRecordAsync\(companyId, automationId, false\)/u);
  assert.match(route, /await initRegisteredWorkflowsAsync\(\)/u);
  assert.match(route, /await getRegisteredWorkflowForCompaniesAsync\(automationId, \[companyId\]\)/u);
  assert.match(route, /await startPortableWorkflowRun\(/u);
  assert.doesNotMatch(route, /try \{\s*initDb\(\);/u);
});

test("control-plane readiness stays on the asynchronous PostgreSQL boundary", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/server/src/index.ts"), "utf8");
  const routeStart = source.indexOf('app.get("/api/v1/companies/:companyId/control-plane/readiness"');
  const routeEnd = source.indexOf('app.get("/api/v1/companies/:companyId/jobs"', routeStart);
  assert.ok(routeStart >= 0);
  assert.ok(routeEnd > routeStart);
  const route = source.slice(routeStart, routeEnd);
  assert.match(route, /app\.get\("\/api\/v1\/companies\/:companyId\/control-plane\/readiness", async/u);
  assert.match(route, /if \(dbBackend === "postgres"\)/u);
  assert.match(route, /await requireCompanyAccessAsync\(companyId, \["owner", "admin", "operator"\]\)/u);
  assert.match(route, /else \{\s*initDb\(\);/u);
  assert.doesNotMatch(route, /try \{\s*initDb\(\);/u);
});

test("PostgreSQL dashboard HTTP read uses the async fast projection", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/server/src/index.ts"), "utf8");
  const routeStart = source.indexOf('app.get("/api/dashboard"');
  const routeEnd = source.indexOf('app.get("/api/codex/capabilities"', routeStart);
  assert.ok(routeStart >= 0);
  assert.ok(routeEnd > routeStart);
  const route = source.slice(routeStart, routeEnd);
  assert.match(route, /await getPostgresFastDashboardAsync\(\)/u);
  assert.match(route, /postgres_dashboard_read_timeout/u);
  assert.doesNotMatch(route, /res\.json\(getDashboard\(\)\)/u);

  const registeredRouteStart = source.indexOf('app.get("/api/registered-workflows"');
  const registeredRouteEnd = source.indexOf('app.get("/api/registered-workflow-inventory"', registeredRouteStart);
  assert.ok(registeredRouteStart >= 0);
  assert.ok(registeredRouteEnd > registeredRouteStart);
  const registeredRoute = source.slice(registeredRouteStart, registeredRouteEnd);
  assert.match(registeredRoute, /if \(dbBackend !== "postgres"\) \{/u);
  assert.doesNotMatch(registeredRoute, /try \{\s*initDb\(\);/u);
  assert.match(registeredRoute, /listRegisteredWorkflowsForCompaniesAsync\(companyIds\)/u);

  const adminRouteStart = source.indexOf('app.get("/api/v1/admin/diagnostics"');
  const adminRouteEnd = source.indexOf('app.get("/api/v1/settings/web-operation-backend"', adminRouteStart);
  assert.ok(adminRouteStart >= 0);
  assert.ok(adminRouteEnd > adminRouteStart);
  const adminRoute = source.slice(adminRouteStart, adminRouteEnd);
  assert.match(adminRoute, /app\.get\("\/api\/v1\/admin\/diagnostics", async/u);
  assert.match(adminRoute, /await listActorCompaniesAsync\(\)/u);
  assert.match(adminRoute, /await querySqlAsync<Record<string, unknown>>/u);
  assert.doesNotMatch(adminRoute, /try \{\s*initDb\(\);/u);

  const backendReadRouteStart = source.indexOf('app.get("/api/v1/settings/web-operation-backend"');
  const backendReadRouteEnd = source.indexOf('app.put("/api/v1/settings/web-operation-backend"', backendReadRouteStart);
  assert.ok(backendReadRouteStart >= 0);
  assert.ok(backendReadRouteEnd > backendReadRouteStart);
  const backendReadRoute = source.slice(backendReadRouteStart, backendReadRouteEnd);
  assert.doesNotMatch(backendReadRoute, /try \{\s*initDb\(\);/u);
  assert.match(backendReadRoute, /webOperationBackendReadbackAsync\(\)/u);

  const analyticsRouteStart = source.indexOf('app.get("/api/v1/companies/:companyId/analytics/performance"');
  const analyticsRouteEnd = source.indexOf('app.post("/api/v1/companies/:companyId/automations"', analyticsRouteStart);
  assert.ok(analyticsRouteStart >= 0);
  assert.ok(analyticsRouteEnd > analyticsRouteStart);
  const analyticsRoute = source.slice(analyticsRouteStart, analyticsRouteEnd);
  assert.match(analyticsRoute, /app\.get\("\/api\/v1\/companies\/:companyId\/analytics\/performance", async/u);
  assert.match(analyticsRoute, /await buildCompanyAnalyticsAsync\(/u);
  assert.match(analyticsRoute, /await requireCompanyAccessAsync\(companyId\)/u);
  assert.doesNotMatch(analyticsRoute, /try \{\s*initDb\(\);/u);

  const asyncStart = source.indexOf("async function getPostgresFastDashboardAsync");
  const asyncEnd = source.indexOf("function buildPostgresFastDashboard", asyncStart);
  assert.ok(asyncStart >= 0);
  assert.ok(asyncEnd > asyncStart);
  const asyncProjection = source.slice(asyncStart, asyncEnd);
  assert.match(asyncProjection, /await (?:withPostgresDashboardReadTimeout\()?listRegisteredWorkflowsAsync\(\)/u);
  assert.match(asyncProjection, /querySqlBatchAsync\(/u);
  assert.match(asyncProjection, /withPostgresDashboardReadTimeout\(/u);
  assert.doesNotMatch(asyncProjection, /querySqlBatch\(/u);
});

test("PostgreSQL company read routes avoid synchronous repository reads", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/server/src/index.ts"), "utf8");
  const routes = [
    ["/api/v1/companies/:companyId/automations/:automationId", "getAutomationRecordAsync", "listAutomationSchedulesAsync"],
    ["/api/v1/companies/:companyId/automations/:automationId/versions", "listAutomationVersionsAsync"],
    ["/api/v1/companies/:companyId/automations/:automationId/schedule", "listAutomationSchedulesAsync"],
    ["/api/v1/companies/:companyId/job-application-target-admissions", "listTargetAdmissionsAsync"],
    ["/api/v1/companies/:companyId/approvals", "listCompanyApprovalsAsync"],
    ["/api/v1/companies/:companyId/memory", "listCompanyMemoryAsync"],
    ["/api/v1/companies/:companyId/connection-account-refs", "listCompanyConnectionRefsAsync"]
  ] as const;
  for (const [path, ...asyncHelpers] of routes) {
    const start = source.indexOf(`app.get("${path}`);
    assert.ok(start >= 0, `route missing: ${path}`);
    const nextApp = source.indexOf("\napp.", start + 1);
    const nextLoop = source.indexOf("\nfor (const paused", start + 1);
    const routeEnds = [nextApp, nextLoop].filter((candidate) => candidate > start);
    const routeEnd = routeEnds.length ? Math.min(...routeEnds) : source.length;
    const route = source.slice(start, routeEnd);
    assert.match(route, /app\.get\([^\n]+, async/u, `route is not async: ${path}`);
    assert.match(route, /if \(dbBackend !== "postgres"\) initDb\(\);/u, `sqlite guard missing: ${path}`);
    assert.doesNotMatch(route, /try \{\s*initDb\(\);/u, `sync initDb remains: ${path}`);
    for (const helper of asyncHelpers) assert.match(route, new RegExp(`await .*${helper}`), `async helper missing: ${helper}`);
  }
});

test("PostgreSQL target admission creation writes to the same async source of truth as readback", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/server/src/index.ts"), "utf8");
  const routeStart = source.indexOf('app.post("/api/v1/companies/:companyId/job-application-target-admissions"');
  const routeEnd = source.indexOf('app.get("/api/v1/companies/:companyId/job-application-reconciliations"', routeStart);
  assert.ok(routeStart >= 0);
  assert.ok(routeEnd > routeStart);
  const route = source.slice(routeStart, routeEnd);
  assert.match(route, /app\.post\([^\n]+, async/u);
  assert.match(route, /const postgres = dbBackend === "postgres"/u);
  assert.match(route, /if \(!postgres\) initDb\(\);/u);
  assert.match(route, /await requireCompanyAccessAsync\(companyId, \["owner", "admin", "operator"\]\)/u);
  assert.match(route, /await createTargetAdmissionAsync\(/u);
  assert.doesNotMatch(route, /try \{\s*initDb\(\);/u);

  const admission = readFileSync(resolve(process.cwd(), "apps/server/src/jobApplications/targetAdmission.ts"), "utf8");
  assert.match(admission, /export async function createTargetAdmissionAsync/u);
  assert.match(admission, /runIdempotentSqlMutationAsync\(/u);
  const idempotency = readFileSync(resolve(process.cwd(), "apps/server/src/automations/idempotency.ts"), "utf8");
  assert.match(idempotency, /export async function runIdempotentSqlMutationAsync/u);
  assert.match(idempotency, /await runSqlTransactionAsync\(/u);
});

test("PostgreSQL connection reference mutations use the async repository boundary", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/server/src/index.ts"), "utf8");
  const routes = [
    ['app.put("/api/v1/companies/:companyId/connection-account-refs/:platform/:accountRef"', "saveCompanyConnectionRefAsync"],
    ['app.post("/api/v1/companies/:companyId/connection-account-refs/:connectionId/reconnect"', "requestCompanyConnectionReconnectAsync"],
    ['app.post("/api/v1/companies/:companyId/connection-account-refs/:connectionId/revoke"', "revokeCompanyConnectionRefAsync"]
  ] as const;
  for (const [marker, helper] of routes) {
    const start = source.indexOf(marker);
    assert.ok(start >= 0, `route missing: ${marker}`);
    const nextApp = source.indexOf("\napp.", start + 1);
    const route = source.slice(start, nextApp > start ? nextApp : source.length);
    assert.match(route, /app\.(?:put|post)\([^\n]+, async/u, `route is not async: ${marker}`);
    assert.match(route, /if \(dbBackend !== "postgres"\) initDb\(\);/u, `sqlite guard missing: ${marker}`);
    assert.doesNotMatch(route, /try \{\s*initDb\(\);/u, `sync initDb remains: ${marker}`);
    assert.match(route, new RegExp(`await .*${helper}`), `async helper missing: ${helper}`);
  }
  const repository = readFileSync(resolve(process.cwd(), "apps/server/src/automations/repository.ts"), "utf8");
  assert.match(repository, /export async function saveCompanyConnectionRefAsync/u);
  assert.match(repository, /export async function requestCompanyConnectionReconnectAsync/u);
  assert.match(repository, /export async function revokeCompanyConnectionRefAsync/u);
  assert.match(repository, /runSqlTransactionAsync\(/u);
});

test("Admin diagnostics does not synchronously read secret storage for capability health", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/server/src/index.ts"), "utf8");
  const routeStart = source.indexOf('app.get("/api/v1/admin/diagnostics"');
  const routeEnd = source.indexOf('app.get("/api/v1/settings/web-operation-backend"', routeStart);
  assert.ok(routeStart >= 0);
  assert.ok(routeEnd > routeStart);
  const route = source.slice(routeStart, routeEnd);
  assert.match(route, /getDashboardExpensiveSnapshot\(\{ allowStoredSecretRead: false \}\)/u);
  const snapshotStart = source.indexOf("function getDashboardExpensiveSnapshot");
  const snapshotEnd = source.indexOf("export function getDashboard", snapshotStart);
  assert.ok(snapshotStart >= 0);
  assert.ok(snapshotEnd > snapshotStart);
  const snapshot = source.slice(snapshotStart, snapshotEnd);
  assert.match(snapshot, /getCodexCapabilities\(\{ allowStoredSecretRead \}\)/u);
  assert.match(snapshot, /getBrowserHealth\(\{ allowStoredSecretRead \}\)/u);
});

test("PostgreSQL server startup uses the async schema boundary before listen", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/server/src/index.ts"), "utf8");
  const start = source.indexOf("export async function startServer");
  const end = source.indexOf("if (process.argv[1] === fileURLToPath(import.meta.url))", start);
  assert.ok(start >= 0);
  assert.ok(end > start);
  const startup = source.slice(start, end);
  assert.match(startup, /await initializePostgresSchemaAsync\(\)/u);
  assert.doesNotMatch(startup, /if \(dbBackend === "postgres"\) initDb\(\);/u);
  assert.match(startup, /void warmPostgresMvpState\(\{ \.\.\.startupMvpStateWarmupOptions\(\), projection: "summary" \}\)/u);
  assert.doesNotMatch(startup, /await Promise\.race\(\[\s*startupWarmup/u);
  assert.match(startup, /const server = app\.listen\(/u);
  assert.match(source.slice(end), /void startServer\(\)\.catch/u);

  const clientSource = readFileSync(resolve(process.cwd(), "apps/server/src/db/client.ts"), "utf8");
  const asyncStart = clientSource.indexOf("export async function initializePostgresSchemaAsync");
  const asyncEnd = clientSource.indexOf("export function initializePostgresSchemaUnderLock", asyncStart);
  assert.ok(asyncStart >= 0);
  assert.ok(asyncEnd > asyncStart);
  const asyncBoundary = clientSource.slice(asyncStart, asyncEnd);
  assert.match(asyncBoundary, /queryPostgresAsyncRaw\(/u);
  assert.match(asyncBoundary, /await runPostgresWorkerInitializeAsync\(\)/u);
  assert.doesNotMatch(asyncBoundary, /runPostgresWorkerInitialize\(\)/u);
});

test("portable workflow entrypoint does not re-enter synchronous PostgreSQL initDb", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/server/src/runs/portableWorkflowEntrypoint.ts"), "utf8");
  const start = source.indexOf("export async function startPortableWorkflowRun");
  const workflowLine = source.indexOf("  const workflow =", start);
  assert.ok(start >= 0);
  assert.ok(workflowLine > start);
  const entrypointAdmission = source.slice(start, workflowLine);
  assert.match(entrypointAdmission, /if \(dbBackend !== "postgres"\) initDb\(\);/u);
  assert.doesNotMatch(entrypointAdmission, /^\s*initDb\(\);$/mu);
});

test("portable PostgreSQL business admission creates its missing pending approval asynchronously", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/server/src/runs/portableWorkflowEntrypoint.ts"), "utf8");
  const start = source.indexOf("async function preparePortableExternalApprovalPostgres");
  const end = source.indexOf("const portableTriggers", start);
  assert.ok(start >= 0);
  assert.ok(end > start);
  const helper = source.slice(start, end);
  assert.match(helper, /let approval = \(await querySqlAsync/);
  assert.match(helper, /if \(!approval\)/);
  assert.match(helper, /createApprovalRequest/);
  assert.match(helper, /await runSqlTransactionAsync/);
  assert.match(helper, /INSERT INTO approvals/);
  assert.doesNotMatch(helper, /throw new Error\("portable_external_approval_missing"\)/u);
});

test("portable business trigger keeps PostgreSQL approval preparation off the synchronous worker boundary", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/server/src/runs/portableWorkflowEntrypoint.ts"), "utf8");
  const start = source.indexOf("if (normalizedInput.effectStage) {");
  const end = source.indexOf("    await completePortableInvocation", start);
  assert.ok(start >= 0);
  assert.ok(end > start);
  const boundary = source.slice(start, end);
  assert.match(boundary, /if \(dbBackend === "postgres"\)/u);
  assert.match(boundary, /preparePortableExternalApprovalPostgres/u);
  assert.match(boundary, /else \{\s*await runWorkerOnce\(result\.runId\);/u);
});

test("portable approval PATCH keeps PostgreSQL decision and target sync asynchronous", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/server/src/index.ts"), "utf8");
  const routeStart = source.indexOf('app.patch("/api/mvp/approvals/:approvalId"');
  const routeEnd = source.indexOf('app.get("/api/mvp/registered-automations"', routeStart);
  assert.ok(routeStart >= 0);
  assert.ok(routeEnd > routeStart);
  const route = source.slice(routeStart, routeEnd);
  assert.match(route, /await actorCompanyIdsAsync/);
  assert.match(route, /await findScopedApprovalAsync/);
  assert.match(route, /await decideStoredApprovalAsync/);
  assert.doesNotMatch(route, /const existing = findScopedApproval\(/u);
  assert.doesNotMatch(route, /state: getMvpStateReadback\(actorCompanyIds\(\)\)/u);
  const helperStart = source.indexOf("async function decideStoredApprovalAsync");
  const helperEnd = source.indexOf("function startWorkerOnceAfterApproval", helperStart);
  assert.ok(helperStart >= 0);
  assert.ok(helperEnd > helperStart);
  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /await runSqlTransactionAsync\(/);
  assert.match(helper, /storedApprovalDecisionSql\(/);
  assert.match(helper, /await getTargetAdmissionAsync\(/);
  assert.match(helper, /await jobApplicationApprovalConnectionGateAsync/);
  assert.match(source, /job_application_account_connection_inventory_empty/u);
  assert.doesNotMatch(helper, /\bexecSql\(/u);
  assert.doesNotMatch(helper, /\bquerySql\(/u);
});

test("job application approval gate requires a fresh verified target connection", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/server/src/index.ts"), "utf8");
  const helperStart = source.indexOf("async function jobApplicationApprovalConnectionGateAsync");
  const helperEnd = source.indexOf("async function decideStoredApproval", helperStart);
  assert.ok(helperStart >= 0);
  assert.ok(helperEnd > helperStart);
  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /workflow_id='job-application-manager'/u);
  assert.match(helper, /ref\.account_ref === targetAccountRef/u);
  assert.match(helper, /ref\.status === "verified"/u);
  assert.match(helper, /ref\.verification_status === "verified"/u);
  assert.match(helper, /ref\.oauth_state === "connected" \|\| ref\.oauth_state === "not_applicable"/u);
  assert.match(helper, /job_application_account_ref_not_verified/u);
  assert.match(helper, /job_application_internal_browser_auth_surface_mismatch/u);
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

test("PostgreSQL pool network errors have a handled, redacted diagnostic boundary", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/server/src/db/client.ts"), "utf8");
  const poolStart = source.indexOf("const pool = new pg.Pool({");
  const poolEnd = source.indexOf("postgresAsyncPool = pool;", poolStart);
  assert.ok(poolStart >= 0);
  assert.ok(poolEnd > poolStart);
  const poolBoundary = source.slice(poolStart, poolEnd);
  assert.match(poolBoundary, /pool\.on\("error"/u);
  assert.match(poolBoundary, /postgresAsyncPoolLastErrorCode/u);
  const handler = poolBoundary.slice(poolBoundary.indexOf('pool.on("error"'));
  assert.doesNotMatch(handler, /postgresUrl/u);
  assert.match(source, /postgresAsyncPoolReadback/u);
});

test("candidate lazy schema ensure restores async readiness between DDL steps", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/server/src/jobApplications/applicationOperations.ts"), "utf8");
  const helperStart = source.indexOf("export async function ensureCandidateSupplySchemaAsync");
  const helperEnd = source.indexOf("export function parseCandidateSupplyInput", helperStart);
  assert.ok(helperStart >= 0);
  assert.ok(helperEnd > helperStart);
  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /if \(candidateSchemaEnsurePromise\) return candidateSchemaEnsurePromise;/u);
  assert.match(helper, /candidateSchemaEnsurePromise = \(async \(\) => \{/u);
  assert.match(helper, /return candidateSchemaEnsurePromise;/u);
  assert.match(helper, /CREATE TABLE IF NOT EXISTS job_application_candidate_supply[\s\S]*?\);[\s\S]*?markAsyncSchemaReady\(\);/u);
  assert.match(helper, /let salaryPeriodReady = false;/u);
  assert.match(helper, /salaryPeriodReady = true;/u);
  assert.match(helper, /if \(salaryPeriodReady\) markAsyncSchemaReady\(\);/u);
  assert.match(helper, /await execSqlAsync\(`[\s\S]*?UPDATE job_application_candidate_supply/u);
});

test("target admission read joins candidate schema readiness before parallel UI readback", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/server/src/index.ts"), "utf8");
  const routeStart = source.indexOf('app.get("/api/v1/companies/:companyId/job-application-target-admissions"');
  const routeEnd = source.indexOf('app.post("/api/v1/companies/:companyId/job-application-target-admissions"', routeStart);
  assert.ok(routeStart >= 0);
  assert.ok(routeEnd > routeStart);
  const route = source.slice(routeStart, routeEnd);
  assert.match(route, /await ensureCandidateSupplySchemaAsync\(\)/u);
  assert.match(route, /await listTargetAdmissionsAsync\(companyId\)/u);
  assert.match(route, /active_admissions: active/u);
  assert.match(route, /blocked_admissions: blocked/u);
});

test("PostgreSQL target admission retry stays on the async source-of-truth boundary", () => {
  const targetSource = readFileSync(resolve(process.cwd(), "apps/server/src/jobApplications/targetAdmission.ts"), "utf8");
  const helperStart = targetSource.indexOf("export async function prepareTargetAdmissionRetryAsync");
  const helperEnd = targetSource.indexOf("export function updateTargetAdmissionStatus", helperStart);
  assert.ok(helperStart >= 0);
  assert.ok(helperEnd > helperStart);
  const helper = targetSource.slice(helperStart, helperEnd);
  assert.match(helper, /await reconcileStaleActiveTargetAdmissionsAsync\(companyId\)/u);
  assert.match(helper, /await getTargetAdmissionAsync\(companyId, admissionId\)/u);
  assert.match(helper, /await querySqlAsync/u);
  assert.match(helper, /await targetAdmissionEffectKeyAsync/u);
  assert.match(helper, /await getDurableTaskEffectAsync/u);
  assert.match(helper, /await runSqlTransactionAsync/u);
  assert.match(helper, /await insertAsync\("worker_events"/u);
  assert.doesNotMatch(helper, /\bquerySql\(/u);
  assert.doesNotMatch(helper, /\brunSqlTransaction\(/u);

  const serverSource = readFileSync(resolve(process.cwd(), "apps/server/src/index.ts"), "utf8");
  const routeStart = serverSource.indexOf('app.post("/api/v1/companies/:companyId/job-application-target-admissions/:admissionId/retry"');
  const routeEnd = serverSource.indexOf('app.post("/api/v1/companies/:companyId/scheduler/run-once"', routeStart);
  assert.ok(routeStart >= 0);
  assert.ok(routeEnd > routeStart);
  const route = serverSource.slice(routeStart, routeEnd);
  assert.match(route, /await requireCompanyAccessAsync\(companyId/u);
  assert.match(route, /await prepareTargetAdmissionRetryAsync\(retryInput\)/u);
  assert.match(route, /prepareTargetAdmissionRetry\(retryInput\)/u);
});

test("registered automation adoption uses the async PostgreSQL management boundary", () => {
  const serverSource = readFileSync(resolve(process.cwd(), "apps/server/src/index.ts"), "utf8");
  const routeStart = serverSource.indexOf('app.post("/api/v1/companies/:companyId/registered-automations/adopt"');
  const routeEnd = serverSource.indexOf('app.get("/api/v1/companies/:companyId/brief"', routeStart);
  assert.ok(routeStart >= 0);
  assert.ok(routeEnd > routeStart);
  const route = serverSource.slice(routeStart, routeEnd);
  assert.match(route, /async \(req, res\)/u);
  assert.match(route, /await initializePostgresSchemaAsync\(\)/u);
  assert.match(route, /await requireCompanyAccessAsync\(companyId/u);
  assert.match(route, /await adoptRegisteredAutomationCatalogAsync\(adoptionInput\)/u);

  const catalogSource = readFileSync(resolve(process.cwd(), "apps/server/src/automations/registeredCatalog.ts"), "utf8");
  const asyncStart = catalogSource.indexOf("export async function adoptRegisteredAutomationCatalogAsync");
  const asyncEnd = catalogSource.indexOf("function synchronizeExistingAutomation", asyncStart);
  assert.ok(asyncStart >= 0);
  assert.ok(asyncEnd > asyncStart);
  const asyncCatalog = catalogSource.slice(asyncStart, asyncEnd);
  assert.match(asyncCatalog, /await getAutomationRecordAsync/u);
  assert.match(asyncCatalog, /await createAutomationRecordAsync/u);
  assert.match(asyncCatalog, /await activateAutomationRecordAsync/u);
  assert.match(asyncCatalog, /await saveAutomationScheduleAsync/u);
  assert.doesNotMatch(asyncCatalog, /\bgetAutomationRecord\(/u);
  assert.doesNotMatch(asyncCatalog, /\bcreateAutomationRecord\(/u);
  assert.doesNotMatch(asyncCatalog, /\bactivateAutomationRecord\(/u);
  assert.doesNotMatch(asyncCatalog, /\bsaveAutomationSchedule\(/u);
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { portableLocalExecutionDeadline, runPortableLocalWorkflowOffThread } from "../aos-portable-local-workflow-execution.mjs";
import { resumePortableLocalReceiptOnly, submitPortableLocalReceipt } from "../aos-portable-remote-worker.mjs";

function claim(mode = "business_effect") {
  return {
    company_id: "local-execution-test-company", workflow_id: "daily-backup-safety-check",
    run_id: "run-local-execution-test", step_id: "step-local-execution-test", idempotency_key: "local-execution-test-key",
    input_bundle_sha256: "a".repeat(64), execution_mode: mode,
    lease_expires_at: new Date(Date.now() + 600_000).toISOString(),
    effect_authority: { expires_at: new Date(Date.now() + 300_000).toISOString() }
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aos-local-execution-test-"));
  mkdirSync(join(root, "apps/server/dist/runs"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  writeFileSync(join(root, "apps/server/dist/runs/portableLocalWorkflow.js"), `
    import { spawn } from "node:child_process";
    function execute(input, business) {
      if (input.scenario === "throw") throw new Error("fixture_after_execution_start");
      if (input.scenario === "orphan") spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, input.delay ?? 250);
      return { status: "complete", exact_blocker: null, workflow_id: input.workflowId,
        external_action_executed: business, read_only_stage_bound: !business,
        cleanup_verified: true, readback_verified: true, business_completion_verified: business,
        same_run_receipt: true, same_run_source_sync: true, adapter_result: {}, runner_receipt: {} };
    }
    export const runPortableLocalWorkflowBusiness = input => execute(input, true);
    export const runPortableLocalWorkflowReadOnly = input => execute(input, false);
  `);
  writeFileSync(join(root, "apps/server/dist/runs/dailyAiResearchSourceSync.js"), 'export { runPortableLocalWorkflowBusiness as runDailyAiResearchSourceSyncBusiness } from "./portableLocalWorkflow.js";');
  return root;
}

test("local execution deadline uses the earlier authority and lease without extension", () => {
  const now = Date.now();
  const value = claim();
  assert.equal(portableLocalExecutionDeadline(value, now), Date.parse(value.effect_authority.expires_at) - 15_000);
  assert.equal(portableLocalExecutionDeadline({ ...value, execution_mode: "read_only" }, now), Date.parse(value.lease_expires_at) - 15_000);
  assert.throws(() => portableLocalExecutionDeadline({ ...value, lease_expires_at: new Date(now).toISOString() }), /deadline_expired/);
  assert.throws(() => portableLocalExecutionDeadline({ ...value, effect_authority: null }), /deadline_expired/);
});

for (const [workflowId, mode] of [["daily-backup-safety-check", "business_effect"], ["daily-backup-safety-check", "read_only"],
  ["obsidian-project-memory-audit", "read_only"], ["nisenprints-existing-product-audit", "read_only"], ["daily-ai-research-source-sync", "business_effect"]]) {
  test(`synchronous local ${workflowId}/${mode} leaves the parent heartbeat event loop responsive`, async () => {
    const root = fixture();
    const value = claim(mode);
    value.workflow_id = workflowId;
    let ticks = 0;
    const interval = setInterval(() => { ticks += 1; }, 15);
    try {
      const result = await runPortableLocalWorkflowOffThread(value, { workflowId: value.workflow_id, runId: value.run_id }, { root });
      assert.equal(result.status, "complete");
      assert.equal(result.external_action_executed, mode === "business_effect");
      assert.equal(result.cleanup_verified, true);
      assert.ok(ticks >= 5, `parent interval ticked ${ticks} times`);
    } finally { clearInterval(interval); rmSync(root, { recursive: true, force: true }); }
  });
}

for (const scenario of ["timeout", "throw", "orphan"]) {
  test(`local child ${scenario} is cleaned and never becomes a false no-effect business receipt`, async () => {
    const root = fixture();
    const value = claim();
    try {
      const result = await runPortableLocalWorkflowOffThread(value, {
        workflowId: value.workflow_id, runId: value.run_id, scenario, delay: scenario === "timeout" ? 5_000 : 0
      }, { root, timeoutMs: scenario === "timeout" ? 120 : Infinity });
      assert.equal(result.cleanup_verified, true);
      if (scenario === "orphan") assert.equal(result.external_action_executed, true);
      else {
        assert.equal(result.status, "blocked");
        assert.equal(result.external_action_executed, null);
        assert.equal(result.adapter_result.reconciliation_required, true);
        assert.equal(result.adapter_result.no_replay, true);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

function workerReceipt(value, externalAction = true) {
  return {
    status: "complete", exact_blocker: null, run_id: value.run_id, step_id: value.step_id, workflow_id: value.workflow_id,
    external_action_executed: externalAction, effects_mode: value.execution_mode,
    browser_surface: "local_worker", readback_verified: true, cleanup_verified: true, same_run_receipt: true
  };
}
const target = { kind: "remote", baseUrl: "https://company-control.example.test", token: "private-test-token-must-not-persist" };

for (const externalAction of [true, false, null]) {
  test(`receipt disconnect preserves a private exact envelope and effect=${externalAction}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "aos-local-receipt-test-"));
    const value = claim();
    const receipt = workerReceipt(value, externalAction);
    let attempts = 0;
    try {
      const result = await submitPortableLocalReceipt(value, target, receipt, root, { request: async () => { attempts += 1; throw new Error("socket disconnected"); } });
      const artifact = join(root, "portable-local-receipt-submission.v1.json");
      const bytes = readFileSync(artifact, "utf8");
      const saved = JSON.parse(bytes);
      assert.equal(statSync(artifact).mode & 0o777, 0o600);
      assert.equal(bytes.includes(target.token), false);
      assert.deepEqual(saved.body.receipt, receipt);
      assert.equal(result.run_id, value.run_id);
      assert.equal(result.external_action_executed, externalAction);
      assert.equal(result.server_receipt_confirmed, false);
      assert.equal(result.reconciliation_required, true);
      assert.equal(attempts, externalAction === null ? 0 : 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

for (const scenario of ["accepted_then_disconnected", "failed_before_accept", "foreign_run", "positive_downgrade", "expired", "wrong_company", "wrong_origin", "worker_restart"]) {
  test(`receipt-only recovery does not replay the provider: ${scenario}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "aos-local-resubmit-test-"));
    const value = claim();
    const receipt = workerReceipt(value);
    let requests = 0;
    const request = async (_target, route, body) => {
      requests += 1;
      assert.equal(route, `/api/portable-worker/${value.run_id}/receipt`);
      assert.deepEqual(body.receipt, receipt);
      if (requests === 1) throw new Error("connection_lost");
      return { ok: true, replayed: scenario === "accepted_then_disconnected", receipt: {
        ...body.receipt,
        ...(scenario === "foreign_run" ? { run_id: "foreign-run" } : {}),
        ...(scenario === "positive_downgrade" ? { external_action_executed: false } : {})
      } };
    };
    try {
      await submitPortableLocalReceipt(value, target, receipt, root, { request });
      const savedPath = join(root, "portable-local-receipt-submission.v1.json");
      const original = readFileSync(savedPath, "utf8");
      const resumeClaim = scenario === "expired" ? { ...value, lease_expires_at: "2020-01-01T00:00:00.000Z" }
        : scenario === "wrong_company" ? { ...value, company_id: "foreign-company" } : value;
      if (scenario === "worker_restart") {
        const saved = JSON.parse(original);
        saved.body.worker_instance_id = "prior-process-instance";
        writeFileSync(savedPath, JSON.stringify(saved), { mode: 0o600 });
      }
      const resumeTarget = scenario === "wrong_origin" ? { ...target, baseUrl: "https://foreign.example.test" } : target;
      const result = await resumePortableLocalReceiptOnly(resumeClaim, resumeTarget, root, { request });
      assert.equal(result.provider_replayed, false);
      const validRecovery = ["accepted_then_disconnected", "failed_before_accept"].includes(scenario);
      assert.equal(result.status, validRecovery ? "complete" : "blocked");
      assert.equal(result.server_receipt_confirmed === true, validRecovery);
      assert.equal(requests, ["expired", "wrong_company", "wrong_origin", "worker_restart"].includes(scenario) ? 1 : 2);
      if (scenario !== "worker_restart") assert.equal(readFileSync(savedPath, "utf8"), original);
      const before = requests;
      await resumePortableLocalReceiptOnly(resumeClaim, resumeTarget, root, { request });
      assert.equal(requests, before, "the receipt-only retry is bounded to one");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("a crash marker or legacy positive receipt prevents fresh local business execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "aos-local-crash-test-"));
  const value = claim();
  let requests = 0;
  const request = async () => { requests += 1; throw new Error("must_not_call"); };
  try {
    const crashed = await resumePortableLocalReceiptOnly(value, target, root, { request });
    assert.equal(crashed.external_action_executed, null);
    writeFileSync(join(root, "portable-local-worker-receipt.v1.json"), JSON.stringify(workerReceipt(value)), { mode: 0o600 });
    const legacy = await resumePortableLocalReceiptOnly(value, target, root, { request });
    assert.equal(legacy.external_action_executed, true);
    assert.equal(legacy.no_replay, true);
    assert.equal(requests, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("resident local worker publishes heartbeat during synchronous work and does not run a claimed result twice", { timeout: 30_000 }, async () => {
  const root = fixture();
  const value = claim("read_only");
  const runRoot = join(root, "artifacts", value.run_id);
  // The fake adapter blocks for six seconds and counts invocations locally.
  writeFileSync(join(root, "apps/server/dist/runs/portableLocalWorkflow.js"), `
    import { appendFileSync } from "node:fs";
    export function runPortableLocalWorkflowReadOnly(input) {
      appendFileSync(${JSON.stringify(join(root, "adapter-calls"))}, "one\\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6000);
      return { status: "complete", exact_blocker: null, workflow_id: input.workflowId,
        external_action_executed: false, read_only_stage_bound: true, cleanup_verified: true,
        readback_verified: true, business_completion_verified: false, adapter_result: {} };
    }
  `);
  let receipts = 0;
  let claims = 0;
  const heartbeats = [];
  let finalResult;
  let resolveFinal;
  const done = new Promise((resolve) => { resolveFinal = resolve; });
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/portable-worker/heartbeat") {
      heartbeats.push(Date.now()); response.end(JSON.stringify({ ok: true, heartbeat: { heartbeat_at: new Date().toISOString() } }));
    } else if (request.url === "/api/portable-worker/claim") {
      claims += 1; response.end(JSON.stringify({ ok: true, run: claims <= 2 ? value : null }));
    } else if (request.url === `/api/portable-worker/${value.run_id}/receipt`) {
      receipts += 1;
      if (receipts === 1) { response.statusCode = 503; response.end("{}"); }
      else response.end(JSON.stringify({ ok: true, replayed: false, receipt: JSON.parse(text).receipt }));
    } else { response.statusCode = 404; response.end("{}"); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const child = spawn(process.execPath, [new URL("../aos-portable-remote-worker.mjs", import.meta.url).pathname], {
    env: { ...process.env, AUTOMATION_OS_REPO_ROOT: root,
      AUTOMATION_OS_PORTABLE_REMOTE_ARTIFACT_ROOT: join(root, "artifacts"),
      AUTOMATION_OS_PORTABLE_QUEUE_AUTHORITY: "local", AUTOMATION_OS_PORTABLE_LOCAL_QUEUE_URL: `http://127.0.0.1:${address.port}`,
      AUTOMATION_OS_PORTABLE_LOCAL_QUEUE_COMPANY_ID: value.company_id, AUTOMATION_OS_PORTABLE_REMOTE_POLL_MS: "5000" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    for (const line of stdout.trim().split("\n")) {
      try { const parsed = JSON.parse(line); if (parsed.remote_receipt_resynced === true) { finalResult = parsed; resolveFinal(); } } catch {}
    }
  });
  child.stderr.on("data", () => {});
  const closed = once(child, "close");
  let timeout;
  try {
    await Promise.race([done, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("resident_fixture_timeout")), 20_000); })]);
    assert.equal(finalResult.status, "complete");
    assert.equal(finalResult.provider_replayed, false);
    assert.equal(receipts, 2);
    assert.equal(readFileSync(join(root, "adapter-calls"), "utf8"), "one\n");
    assert.ok(heartbeats.length >= 3, "worker heartbeat continues while the six-second adapter runs");
    assert.ok(heartbeats[1] - heartbeats[0] >= 4000);
    assert.equal(JSON.parse(readFileSync(join(runRoot, "portable-protected-readback.v1.json"), "utf8")).protected_readback.status, "verified");
  } finally {
    clearTimeout(timeout);
    child.kill("SIGTERM");
    await closed;
    server.close();
    await once(server, "close");
    rmSync(root, { recursive: true, force: true });
  }
});

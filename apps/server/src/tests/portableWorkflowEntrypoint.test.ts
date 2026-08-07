import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-portable-entrypoint-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");
process.env.AUTOMATION_OS_ARTIFACT_ROOT = join(tempRoot, "artifacts");
process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = "canary";

const db = await import("../db/client.js");
const { hashIdempotencyRequest } = await import("../automations/idempotency.js");
const { initRegisteredWorkflows } = await import("../registeredWorkflows.js");
const { startPortableWorkflowRun } = await import("../runs/portableWorkflowEntrypoint.js");
const { runWorkerOnce } = await import("../runs/workerEngine.js");

test("portable entrypoint is shared by AOS UI, App bridge, and other schedulers, with idempotent run binding", async () => {
  db.initDb();
  initRegisteredWorkflows();
  const cases = [
    { workflowId: "daily-ai-research-publish-run" as const, sourceTrigger: "automation_os_ui" as const },
    { workflowId: "nisenprints-daily-product-canva-printify-etsy-pinterest" as const, sourceTrigger: "launchd" as const },
    { workflowId: "job-application-manager" as const, sourceTrigger: "github_actions" as const },
    { workflowId: "prompt-transfer-ukiyoe" as const, sourceTrigger: "automation_os_scheduler" as const },
    { workflowId: "sns-multi-poster-ukiyoe" as const, sourceTrigger: "codex_app_bridge" as const },
    { workflowId: "x-authenticated-browser-lane" as const, sourceTrigger: "launchd" as const }
  ];
  for (const [index, item] of cases.entries()) {
    const idempotencyKey = `portable-entrypoint-test-${index + 1}`;
    const companyId = index % 2 === 0 ? "portable_test_company" : undefined;
    const first = await startPortableWorkflowRun({ ...item, idempotencyKey, ...(companyId ? { companyId } : {}) });
    assert.equal(first.replayed, false);
    assert.equal(first.workflowId, item.workflowId);
    assert.equal(first.sourceTrigger, item.sourceTrigger);

    const replay = await startPortableWorkflowRun({ ...item, idempotencyKey, ...(companyId ? { companyId } : {}) });
    assert.equal(replay.replayed, true);
    assert.equal(replay.runId, first.runId);

    const processed = await runWorkerOnce(first.runId);
    assert.equal(processed.length, 1);
    const run = db.querySql<{ status: string; company_id: string | null; metadata_json: string }>(
      `SELECT status, company_id, metadata_json FROM runs WHERE id=${db.sqlValue(first.runId)} LIMIT 1`
    )[0];
    assert.equal(run.company_id, companyId ?? null);
    const metadata = JSON.parse(run.metadata_json) as {
      portable_workflow_invocation?: { app_dependency?: boolean; source_trigger?: string };
      exact_blocker?: string;
      external_action_executed?: boolean;
    };
    const proof = db.querySql<{ metadata_json: string }>(
      `SELECT metadata_json FROM proofs WHERE run_id=${db.sqlValue(first.runId)} AND proof_type='worker_receipt' ORDER BY created_at DESC LIMIT 1`
    )[0];
    const proofMetadata = JSON.parse(proof.metadata_json) as { source_trigger?: string; idempotency_key?: string };
    assert.equal(run.status, "blocked");
    assert.equal(metadata.portable_workflow_invocation?.app_dependency, false);
    assert.equal(metadata.portable_workflow_invocation?.source_trigger, item.sourceTrigger);
    assert.equal(proofMetadata.source_trigger, item.sourceTrigger);
    assert.equal(proofMetadata.idempotency_key, idempotencyKey);
    assert.equal(metadata.exact_blocker, "portable_external_effects_disabled");
    assert.equal(metadata.external_action_executed, false);
  }
});

test("portable invocation binding rejects payload drift and does not cross company scope", async () => {
  const first = await startPortableWorkflowRun({
    workflowId: "daily-ai-research-publish-run",
    sourceTrigger: "automation_os_ui",
    idempotencyKey: "portable-binding-scope",
    companyId: "portable_scope_a",
    dueKey: "due-a"
  });
  await assert.rejects(
    () => startPortableWorkflowRun({
      workflowId: "daily-ai-research-publish-run",
      sourceTrigger: "automation_os_ui",
      idempotencyKey: "portable-binding-scope",
      companyId: "portable_scope_a",
      dueKey: "due-b"
    }),
    /portable_workflow_invocation_payload_conflict/
  );
  const otherScope = await startPortableWorkflowRun({
    workflowId: "daily-ai-research-publish-run",
    sourceTrigger: "automation_os_ui",
    idempotencyKey: "portable-binding-scope",
    companyId: "portable_scope_b",
    dueKey: "due-a"
  });
  assert.notEqual(otherScope.runId, first.runId);
});

test("portable invocation stays fail-closed while another owner has a pending reservation", async () => {
  const input = {
    workflowId: "daily-ai-research-publish-run" as const,
    sourceTrigger: "automation_os_ui" as const,
    idempotencyKey: "portable-pending-reservation",
    companyId: "portable_pending_scope",
    dueKey: "pending-due"
  };
  const requestHash = hashIdempotencyRequest({
    workflow_id: input.workflowId,
    source_trigger: input.sourceTrigger,
    company_id: input.companyId,
    due_key: input.dueKey,
    idempotency_key: input.idempotencyKey
  });
  const reservationId = "portable_pending_reservation_test";
  db.insert("portable_workflow_invocations", {
    id: reservationId,
    workflow_id: input.workflowId,
    source_trigger: input.sourceTrigger,
    company_scope: input.companyId,
    company_id: input.companyId,
    idempotency_key: input.idempotencyKey,
    request_hash: requestHash,
    status: "pending",
    run_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });
  try {
    await assert.rejects(() => startPortableWorkflowRun(input), /portable_workflow_invocation_pending/);
  } finally {
    db.execSql(`DELETE FROM portable_workflow_invocations WHERE id=${db.sqlValue(reservationId)}`);
  }
});

test("portable invocation converges to one run across concurrent processes", async () => {
  const entrypointUrl = new URL("../runs/portableWorkflowEntrypoint.js", import.meta.url).href;
  const code = `
    const { startPortableWorkflowRun } = await import(${JSON.stringify(entrypointUrl)});
    const result = await startPortableWorkflowRun({
      workflowId: "daily-ai-research-publish-run",
      sourceTrigger: "automation_os_ui",
      idempotencyKey: "portable-concurrent-processes",
      companyId: "portable_concurrent_scope",
      dueKey: "concurrent-due"
    });
    console.log(JSON.stringify(result));
  `;
  const runChild = () => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", code], {
      cwd: process.cwd(),
      env: { ...process.env, AUTOMATION_OS_DB: process.env.AUTOMATION_OS_DB!, AUTOMATION_OS_PORTABLE_WORKER_MODE: "canary" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (exitCode) => {
      if (exitCode === 0) resolve(stdout.trim().split("\\n").at(-1) ?? "");
      else reject(new Error(`portable_concurrent_process_failed:${exitCode}:${stderr.trim()}`));
    });
  });
  const results = await Promise.all([runChild(), runChild()]).then((items) => items.map((item) => JSON.parse(item) as { runId: string; replayed: boolean }));
  assert.equal(new Set(results.map((item) => item.runId)).size, 1);
  assert.deepEqual(results.map((item) => item.replayed).sort(), [false, true]);
  const invocationRows = db.querySql<{ idempotency_key: string; status: string; run_id: string | null }>(
    `SELECT idempotency_key, status, run_id FROM portable_workflow_invocations WHERE idempotency_key=${db.sqlValue("portable-concurrent-processes")}`
  );
  assert.equal(invocationRows.length, 1, JSON.stringify({ results, invocationRows, db: process.env.AUTOMATION_OS_DB }));
});

test("portable entrypoint defaults to the external Browser Use CLI worker when the server has no explicit mode", async () => {
  const previous = process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE;
  delete process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE;
  try {
    const started = await startPortableWorkflowRun({
      workflowId: "daily-ai-research-publish-run",
      sourceTrigger: "automation_os_ui",
      idempotencyKey: "portable-entrypoint-worker-mode-inheritance"
    });
    const run = db.querySql<{ metadata_json: string }>(
      `SELECT metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`
    )[0];
    const metadata = JSON.parse(run.metadata_json) as { portable_worker?: { mode?: string } };
    assert.equal(metadata.portable_worker?.mode, "external");

    await runWorkerOnce(started.runId);
    const approval = db.querySql<{ resource_locks_json: string }>(
      `SELECT resource_locks_json FROM approvals WHERE run_id=${db.sqlValue(started.runId)} ORDER BY created_at DESC LIMIT 1`
    )[0];
    assert.ok(approval);
    assert.match(approval.resource_locks_json, /portable_external:daily-ai-research-publish-run/);
  } finally {
    if (previous === undefined) delete process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE;
    else process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = previous;
  }
});

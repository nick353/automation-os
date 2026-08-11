import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-portable-entrypoint-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");
process.env.AUTOMATION_OS_ARTIFACT_ROOT = join(tempRoot, "artifacts");
process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = "canary";

const db = await import("../db/client.js");
const { hashIdempotencyRequest } = await import("../automations/idempotency.js");
const { initRegisteredWorkflows } = await import("../registeredWorkflows.js");
const { startPortableWorkflowRun } = await import("../runs/portableWorkflowEntrypoint.js");
const {
  getRunContractForProofEvaluation,
  materializePortableInputBundleForMacWorker,
  runPortableMacWorkerOnce,
  runWorkerOnce
} = await import("../runs/workerEngine.js");

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
      execution_routing?: { executionSurface?: string; selectedRouteId?: string; plannedAdapters?: string[] };
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
    assert.equal(metadata.execution_routing?.executionSurface, "worker_loop");
    assert.equal(metadata.execution_routing?.selectedRouteId, "automation_os_portable_worker");
    assert.deepEqual(metadata.execution_routing?.plannedAdapters, ["browser_use_cli"]);
  }
});

test("Daily AI and NisenPrints accept only their workflow-owned reference readback stage", async () => {
  const daily = await startPortableWorkflowRun({
    workflowId: "daily-ai-research-publish-run",
    sourceTrigger: "automation_os_ui",
    idempotencyKey: "portable-daily-reference-readback-stage",
    companyId: "portable_reference_scope",
    readOnlyStage: "reference_readback"
  });
  const nisenprints = await startPortableWorkflowRun({
    workflowId: "nisenprints-daily-product-canva-printify-etsy-pinterest",
    sourceTrigger: "automation_os_ui",
    idempotencyKey: "portable-nisenprints-reference-readback-stage",
    companyId: "portable_reference_scope",
    readOnlyStage: "reference_readback"
  });
  for (const runId of [daily.runId, nisenprints.runId]) {
    const run = db.querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${db.sqlValue(runId)} LIMIT 1`)[0];
    const metadata = JSON.parse(run.metadata_json) as {
      read_only_stage?: string;
      portable_workflow_invocation?: { read_only_stage?: string };
      portable_worker?: { read_only_stage?: string };
    };
    assert.equal(metadata.read_only_stage, "reference_readback");
    assert.equal(metadata.portable_workflow_invocation?.read_only_stage, "reference_readback");
    assert.equal(metadata.portable_worker?.read_only_stage, "reference_readback");
    const processed = await runWorkerOnce(runId);
    assert.equal(processed.length, 1);
    const finalRun = db.querySql<{ status: string; metadata_json: string }>(
      `SELECT status, metadata_json FROM runs WHERE id=${db.sqlValue(runId)} LIMIT 1`
    )[0];
    const finalMetadata = JSON.parse(finalRun.metadata_json) as {
      exact_blocker?: string | null;
      external_action_executed?: boolean;
      read_only_stage?: string;
    };
    assert.equal(finalRun.status, "blocked");
    assert.equal(finalMetadata.read_only_stage, "reference_readback");
    assert.equal(finalMetadata.exact_blocker, "portable_external_effects_disabled");
    assert.equal(finalMetadata.external_action_executed, false);
  }
  const nisenMetadata = JSON.parse(
    db.querySql<{ metadata_json: string }>(
      `SELECT metadata_json FROM runs WHERE id=${db.sqlValue(nisenprints.runId)} LIMIT 1`
    )[0].metadata_json
  ) as Record<string, unknown>;
  assert.equal(getRunContractForProofEvaluation(nisenprints.runId, nisenMetadata), undefined);
  await assert.rejects(
    () => startPortableWorkflowRun({
      workflowId: "daily-ai-research-publish-run",
      sourceTrigger: "automation_os_ui",
      idempotencyKey: "portable-daily-candidate-stage-invalid",
      readOnlyStage: "candidate_supply"
    }),
    /portable_read_only_stage_unsupported/
  );
  await assert.rejects(
    () => startPortableWorkflowRun({
      workflowId: "nisenprints-daily-product-canva-printify-etsy-pinterest",
      sourceTrigger: "automation_os_ui",
      idempotencyKey: "portable-nisenprints-candidate-stage-invalid",
      readOnlyStage: "candidate_supply"
    }),
    /portable_read_only_stage_unsupported/
  );
});

test("durable-only Mac worker picks up portable runs without a Codex App controller", async () => {
  const started = await startPortableWorkflowRun({
    workflowId: "job-application-manager",
    sourceTrigger: "automation_os_scheduler",
    idempotencyKey: "portable-mac-worker-pickup-regression",
    companyId: "portable_mac_worker_scope",
    readOnlyStage: "candidate_supply",
    inputBundle: {
      source_snapshot_id: "portable-mac-worker-snapshot",
      supply_run_id: "portable-mac-worker-supply",
      bucket: "japan_targeted",
      remaining: 0,
      margin: 0
    }
  });
  const picked = await runPortableMacWorkerOnce();
  assert.equal(picked.length, 1);
  assert.equal(picked[0]?.runId, started.runId);
  const run = db.querySql<{ status: string; metadata_json: string }>(
    `SELECT status, metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`
  )[0];
  const metadata = JSON.parse(run.metadata_json) as { external_action_executed?: boolean };
  assert.equal(run.status, "blocked");
  assert.equal(metadata.external_action_executed, false);
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

test("portable workflow persists a non-secret input bundle inside the current run artifact", async () => {
  const inputBundle = {
    job_url: "https://example.com/jobs/portable-input-bound",
    application_url: "https://example.com/jobs/portable-input-bound/apply",
    candidate_key: "candidate-portable-input-bound",
    bucket: "japan_targeted" as const,
    sequence: 1,
    attempt: 1,
    source_snapshot_id: "snapshot-portable-input-bound",
    supply_run_id: "supply-portable-input-bound",
    company: "Example Company",
    role: "Marketing",
  };
  const started = await startPortableWorkflowRun({
    workflowId: "job-application-manager",
    sourceTrigger: "automation_os_ui",
    idempotencyKey: "portable-input-bundle-boundary",
    companyId: "portable_input_bundle_scope",
    inputBundle
  });
  const bundlePath = join(process.env.AUTOMATION_OS_ARTIFACT_ROOT!, started.runId, "portable-input-bundle.v1.json");
  assert.equal(existsSync(bundlePath), true);
  assert.equal(statSync(bundlePath).mode & 0o777, 0o600);
  const bundle = JSON.parse(readFileSync(bundlePath, "utf8")) as { schema?: string; workflow_id?: string; run_id?: string; input?: typeof inputBundle };
  assert.equal(bundle.schema, "automation_os_portable_workflow_input_bundle.v1");
  assert.equal(bundle.workflow_id, "job-application-manager");
  assert.equal(bundle.run_id, started.runId);
  assert.deepEqual(bundle.input, inputBundle);
  const run = db.querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`)[0];
  const metadata = JSON.parse(run.metadata_json) as { portable_input_bundle?: { path?: string; sha256?: string; input?: typeof inputBundle }; portable_workflow_invocation?: { input_bundle_path?: string } };
  assert.equal(metadata.portable_input_bundle?.path, bundlePath);
  assert.equal(metadata.portable_workflow_invocation?.input_bundle_path, bundlePath);
  assert.deepEqual(metadata.portable_input_bundle?.input, inputBundle);
  assert.match(String(metadata.portable_input_bundle?.sha256 || ""), /^[a-f0-9]{64}$/u);
  await assert.rejects(
    () => startPortableWorkflowRun({
      workflowId: "job-application-manager",
      sourceTrigger: "automation_os_ui",
      idempotencyKey: "portable-input-bundle-secret-rejected",
      inputBundle: { ...inputBundle, token: "must-not-cross-boundary" } as never
    }),
    /portable_workflow_input_bundle_key_forbidden/
  );
});

test("Mac worker reuses the canonical run input bundle when its metadata includes server-only creation fields", () => {
  const runId = "run_portable_input_bundle_creation_field_compatibility";
  const runRoot = join(process.env.AUTOMATION_OS_ARTIFACT_ROOT!, runId);
  const bundlePath = join(runRoot, "portable-input-bundle.v1.json");
  const input = {
    source_snapshot_id: "snapshot-creation-field-compatibility",
    supply_run_id: "supply-creation-field-compatibility",
    bucket: "japan_targeted",
    remaining: 1,
    margin: 1,
  };
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  chmodSync(runRoot, 0o700);
  writeFileSync(bundlePath, `${JSON.stringify({
    schema: "automation_os_portable_workflow_input_bundle.v1",
    workflow_id: "job-application-manager",
    run_id: runId,
    input,
    created_at: "2026-08-10T13:00:00.000Z",
  }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(bundlePath, 0o600);
  assert.equal(materializePortableInputBundleForMacWorker({
    runId,
    workflowId: "job-application-manager",
    input,
  }), bundlePath);
  assert.match(readFileSync(bundlePath, "utf8"), /created_at/);
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
  const sourceEntrypointUrl = new URL("../runs/portableWorkflowEntrypoint.ts", import.meta.url);
  const compiledEntrypointUrl = new URL("../runs/portableWorkflowEntrypoint.js", import.meta.url);
  const entrypointUrl = existsSync(fileURLToPath(sourceEntrypointUrl))
    ? sourceEntrypointUrl.href
    : compiledEntrypointUrl.href;
  const entrypointLoaderArgs = entrypointUrl.endsWith(".ts") ? ["--import", "tsx"] : [];
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
    const child = spawn(process.execPath, [...entrypointLoaderArgs, "--input-type=module", "--eval", code], {
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

test("business portable starts create the target-bound AOS approval before Mac claim", async () => {
  const previous = process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE;
  process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = "external";
  try {
    const started = await startPortableWorkflowRun({
      workflowId: "job-application-manager",
      sourceTrigger: "automation_os_ui",
      idempotencyKey: "portable-business-admission-preparation",
      companyId: "portable_business_admission_scope",
      effectStage: "one_candidate_submit",
      inputBundle: {
        job_url: "https://example.com/jobs/target-bound",
        application_url: "https://example.com/jobs/target-bound",
        candidate_key: "candidate-target-bound",
        bucket: "japan_targeted",
        sequence: 1,
        attempt: 1,
        source_snapshot_id: "snapshot-target-bound",
        supply_run_id: "supply-target-bound",
        company: "Example Company",
        role: "Marketing Manager",
      },
    });
    assert.equal(started.status, "waiting_approval");
    const approval = db.querySql<{ status: string; company_id: string; run_id: string; step_id: string; action_kind: string; policy_version: string; expires_at: string; resource_locks_json: string }>(
      `SELECT status, company_id, run_id, step_id, action_kind, policy_version, expires_at, resource_locks_json FROM approvals WHERE run_id=${db.sqlValue(started.runId)} ORDER BY created_at ASC LIMIT 1`
    )[0];
    assert.equal(approval.status, "pending");
    assert.equal(approval.company_id, "portable_business_admission_scope");
    assert.equal(approval.run_id, started.runId);
    assert.ok(approval.step_id);
    assert.equal(approval.action_kind, "one_candidate_submit");
    assert.equal(approval.policy_version, "automation_os_portable_external_approval_binding.v1");
    assert.ok(Date.parse(approval.expires_at) > Date.now());
    assert.match(approval.resource_locks_json, /portable_external:job-application-manager:[a-f0-9]{64}/u);
    assert.match(approval.resource_locks_json, /portable_external_target:job-application-manager:[a-f0-9]{64}:portable-business-admission-preparation/u);
    const run = db.querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`)[0];
    const metadata = JSON.parse(run.metadata_json) as { portable_target_bound_approval_binding?: Record<string, unknown>; portable_target_bound_approval_receipt?: Record<string, unknown> };
    assert.equal(metadata.portable_target_bound_approval_binding?.company_id, "portable_business_admission_scope");
    assert.equal(metadata.portable_target_bound_approval_binding?.idempotency_key, "portable-business-admission-preparation");
    assert.equal(metadata.portable_target_bound_approval_binding?.fresh_browser_use_authority_required, true);
    assert.equal(metadata.portable_target_bound_approval_binding?.first_class_root_required, false);
    assert.equal(metadata.portable_target_bound_approval_receipt?.approval_status, "pending");
    const claim = (await import("../runs/portableRemoteWorker.js")).claimPortableMacWorker({
      companyId: "portable_business_admission_scope",
      workerId: "mac-business-admission-test",
      requestedRunId: started.runId,
    });
    assert.equal(claim, null);
  } finally {
    if (previous === undefined) delete process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE;
    else process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = previous;
  }
});

test("Daily AI and NisenPrints business starts fail closed before creating an effect admission without target payload binding", async () => {
  await assert.rejects(
    () => startPortableWorkflowRun({
      workflowId: "daily-ai-research-publish-run",
      sourceTrigger: "automation_os_ui",
      idempotencyKey: "portable-daily-business-binding-missing",
      companyId: "portable_business_binding_scope",
      effectStage: "publish",
      inputBundle: {
        account_ref: "daily-ai-account",
        target_key: "content-001",
        content_key: "content-001",
        source_snapshot_id: "snapshot-001",
      },
    }),
    /portable_business_daily_ai_input_payload_hash_missing/,
  );
  await assert.rejects(
    () => startPortableWorkflowRun({
      workflowId: "nisenprints-daily-product-canva-printify-etsy-pinterest",
      sourceTrigger: "automation_os_ui",
      idempotencyKey: "portable-nisenprints-business-binding-missing",
      companyId: "portable_business_binding_scope",
      effectStage: "business_execute",
      inputBundle: {
        account_ref: "nisenprints-account",
        target_key: "product-001",
        product_key: "product-001",
        asset_manifest_id: "manifest-001",
        payload_hash: "not-a-sha256",
        source_snapshot_id: "snapshot-001",
      },
    }),
    /portable_business_nisenprints_input_payload_hash_invalid/,
  );
});

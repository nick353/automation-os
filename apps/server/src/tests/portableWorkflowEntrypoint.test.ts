import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-portable-entrypoint-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");
process.env.AUTOMATION_OS_ARTIFACT_ROOT = join(tempRoot, "artifacts");
process.env.AOS_WEB_OPERATION_BACKEND_CONFIG = join(tempRoot, "web-operation-backend.json");
process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = "canary";

const db = await import("../db/client.js");
const { hashIdempotencyRequest } = await import("../automations/idempotency.js");
const { initRegisteredWorkflows } = await import("../registeredWorkflows.js");
const { startPortableWorkflowRun } = await import("../runs/portableWorkflowEntrypoint.js");
const { browserSurfaceRequirementForPortableTrigger } = await import("../runs/portableWorkflowEntrypoint.js");
const { startPortableLocalWorkflowRun } = await import("../runs/portableLocalWorkflowEntrypoint.js");
const { runPortableLocalWorkflowAsync, runPortableLocalWorkflowReadOnly } = await import("../runs/portableLocalWorkflow.js");
const { readWebOperationBackendSetting, writeWebOperationBackendSetting } = await import("../runs/webOperationBackendSettings.js");
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
      portable_workflow_invocation?: { app_dependency?: boolean; source_trigger?: string; browser_surface_requirement?: string };
      exact_blocker?: string;
      external_action_executed?: boolean;
      execution_routing?: { executionSurface?: string; selectedRouteId?: string; plannedAdapters?: string[] };
      web_operation_backend?: {
        requested_backend?: string;
        resolved_backend?: string;
        revision?: number;
        browser_surface?: string;
        fallback_allowed?: boolean;
        route_decision_schema?: string;
        routing_mode?: string;
        route_reason?: string;
        route_admission_status?: string;
        route_frozen_after_dispatch?: boolean;
        reroute_after_terminal_no_effect_only?: boolean;
        chrome_profile?: { id?: string; name?: string; directory?: string; surface?: string };
      };
    };
    const proof = db.querySql<{ metadata_json: string }>(
      `SELECT metadata_json FROM proofs WHERE run_id=${db.sqlValue(first.runId)} AND proof_type='worker_receipt' ORDER BY created_at DESC LIMIT 1`
    )[0];
    const proofMetadata = JSON.parse(proof.metadata_json) as { source_trigger?: string; idempotency_key?: string };
    assert.equal(run.status, "blocked");
    assert.equal(metadata.portable_workflow_invocation?.app_dependency, false);
    assert.equal(metadata.portable_workflow_invocation?.source_trigger, item.sourceTrigger);
    const expectedRequirement = "automatic";
    const expectedBackend = "aos_chrome_companion";
    const expectedSurface = "aos_chrome_companion_profile_instance";
    assert.equal(metadata.portable_workflow_invocation?.browser_surface_requirement, expectedRequirement);
    assert.equal(proofMetadata.source_trigger, item.sourceTrigger);
    assert.equal(proofMetadata.idempotency_key, idempotencyKey);
    assert.equal(metadata.exact_blocker, "portable_external_effects_disabled");
    assert.equal(metadata.external_action_executed, false);
    assert.equal(metadata.execution_routing?.executionSurface, "worker_loop");
    assert.equal(metadata.execution_routing?.selectedRouteId, "automation_os_portable_worker");
    assert.deepEqual(metadata.execution_routing?.plannedAdapters, [expectedBackend]);
    assert.equal(metadata.web_operation_backend?.requested_backend, expectedBackend);
    assert.equal(metadata.web_operation_backend?.resolved_backend, expectedBackend);
    assert.ok(Number.isSafeInteger(metadata.web_operation_backend?.revision));
    assert.ok(Number(metadata.web_operation_backend?.revision) >= 1);
    assert.equal(metadata.web_operation_backend?.browser_surface, expectedSurface);
    assert.equal(metadata.web_operation_backend?.fallback_allowed, false);
    assert.equal(metadata.web_operation_backend?.route_decision_schema, "browser_route_decision.v2");
    assert.equal(metadata.web_operation_backend?.routing_mode, "adaptive_two_extension");
    assert.equal(metadata.web_operation_backend?.route_admission_status, "ready");
    assert.equal(metadata.web_operation_backend?.route_frozen_after_dispatch, true);
    assert.equal(metadata.web_operation_backend?.reroute_after_terminal_no_effect_only, true);
    assert.deepEqual(metadata.web_operation_backend?.chrome_profile, {
      id: "profile2",
      name: "Profile 2",
      directory: "Profile 2",
      surface: "signed_chrome_extension_profile2",
    });
  }
});

test("portable triggers leave backend selection to the current AOS UI setting", () => {
  assert.equal(browserSurfaceRequirementForPortableTrigger("automation_os_scheduler"), "automatic");
  assert.equal(browserSurfaceRequirementForPortableTrigger("launchd"), "automatic");
  assert.equal(browserSurfaceRequirementForPortableTrigger("github_actions"), "automatic");
  assert.equal(browserSurfaceRequirementForPortableTrigger("automation_os_ui", "job-application-manager"), "automatic");
  assert.equal(browserSurfaceRequirementForPortableTrigger("codex_app_bridge", "daily-ai-research-publish-run"), "automatic");
  assert.equal(
    browserSurfaceRequirementForPortableTrigger("automation_os_ui", "nisenprints-daily-product-canva-printify-etsy-pinterest"),
    "automatic",
  );
  assert.equal(
    browserSurfaceRequirementForPortableTrigger("codex_app_bridge", "nisenprints-daily-product-canva-printify-etsy-pinterest"),
    "automatic",
  );
});

test("automatic portable runs freeze the backend routed from the AOS UI setting", async () => {
  const previous = readWebOperationBackendSetting();
  let revision = previous.revision;
  const expectedBackends = {
    chrome_plugin: "aos_chrome_companion",
    browser_use_cli: "browser_use_cli",
    aos_chrome_companion: "aos_chrome_companion",
    playwright: "playwright",
  } as const;
  const expectedSurfaces = {
    aos_chrome_companion: "aos_chrome_companion_profile_instance",
    aos_chrome_companion_profile_instance: "aos_chrome_companion_profile_instance",
    browser_use_cli: "browser_use_cli",
    playwright: "playwright",
  } as const;
  try {
    for (const [index, backend] of (["chrome_plugin", "browser_use_cli", "aos_chrome_companion", "playwright"] as const).entries()) {
      const selected = writeWebOperationBackendSetting({
        backend,
        actorUserId: `portable-backend-selection-${index}`,
        expectedRevision: revision,
      });
      revision = selected.revision;
      const started = await startPortableWorkflowRun({
        workflowId: "daily-ai-research-publish-run",
        sourceTrigger: "automation_os_ui",
        idempotencyKey: `portable-backend-selection-${backend}`,
      });
      const run = db.querySql<{ metadata_json: string }>(
        `SELECT metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`
      )[0];
      const metadata = JSON.parse(run.metadata_json) as { web_operation_backend?: { resolved_backend?: string; browser_surface?: string; fallback_allowed?: boolean } };
      const expectedBackend = expectedBackends[backend];
      assert.equal(metadata.web_operation_backend?.resolved_backend, expectedBackend);
      assert.equal(metadata.web_operation_backend?.browser_surface, expectedSurfaces[expectedBackend]);
      assert.equal(metadata.web_operation_backend?.fallback_allowed, false);
    }
  } finally {
    writeWebOperationBackendSetting({
      backend: previous.backend,
      actorUserId: "portable-backend-selection-restore",
      expectedRevision: revision,
    });
  }
});

test("portable Web intent uses the same selected backend snapshot as the Run", async () => {
  const previous = readWebOperationBackendSetting();
  try {
    const selected = writeWebOperationBackendSetting({
      backend: "aos_chrome_companion",
      actorUserId: "portable-intent-surface-test",
      expectedRevision: previous.revision,
    });
    const started = await startPortableWorkflowRun({
      workflowId: "x-authenticated-browser-lane",
      sourceTrigger: "automation_os_ui",
      idempotencyKey: "portable-web-intent-selected-surface",
      webOperationIntent: {
        operation: "read",
        account_ref: "x_readonly_account",
        allowed_origins: ["https://example.com"],
        entry_url: "https://example.com/",
        target: { semantic_query: "home" },
      },
    });
    const run = db.querySql<{ metadata_json: string }>(
      `SELECT metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`
    )[0];
    const metadata = JSON.parse(run.metadata_json) as {
      web_operation_backend?: { browser_surface?: string; revision?: number };
      portable_workflow_invocation?: { web_operation_intent?: { browser_surface?: string } };
    };
    assert.equal(metadata.web_operation_backend?.browser_surface, "aos_chrome_companion_profile_instance");
    assert.equal(metadata.web_operation_backend?.revision, selected.revision);
    assert.equal(metadata.portable_workflow_invocation?.web_operation_intent?.browser_surface, "aos_chrome_companion_profile_instance");
    const processed = await runWorkerOnce(started.runId);
    assert.equal(processed.length, 1);
  } finally {
    writeWebOperationBackendSetting({
      backend: previous.backend,
      actorUserId: "portable-intent-surface-test-restore",
      expectedRevision: readWebOperationBackendSetting().revision,
    });
  }
});

test("portable Companion task ownership is persisted and included in the invocation binding", async () => {
  const started = await startPortableWorkflowRun({
    workflowId: "daily-ai-research-publish-run",
    sourceTrigger: "automation_os_ui",
    idempotencyKey: "portable-companion-task-binding",
    companyId: "portable_companion_scope",
    companionTaskId: "01a03a2e-7239-7663-b84a-81a023d46592"
  });
  const run = db.querySql<{ metadata_json: string }>(
    `SELECT metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`
  )[0];
  const metadata = JSON.parse(run.metadata_json) as {
    companion_task_id?: string;
    portable_workflow_invocation?: { companion_task_id?: string };
  };
  assert.equal(metadata.companion_task_id, "01a03a2e-7239-7663-b84a-81a023d46592");
  assert.equal(metadata.portable_workflow_invocation?.companion_task_id, "01a03a2e-7239-7663-b84a-81a023d46592");
  await runWorkerOnce(started.runId);
  await assert.rejects(
    () => startPortableWorkflowRun({
      workflowId: "daily-ai-research-publish-run",
      sourceTrigger: "automation_os_ui",
      idempotencyKey: "portable-companion-task-binding-invalid",
      companionTaskId: "../foreign-task"
    }),
    /portable_companion_task_id_invalid/
  );
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
  const jobReference = await startPortableWorkflowRun({
    workflowId: "job-application-manager",
    sourceTrigger: "automation_os_ui",
    idempotencyKey: "portable-job-reference-readback-no-effect",
    companyId: "portable_job_reference_scope",
    readOnlyStage: "reference_readback"
  });
  const jobReferenceMetadata = JSON.parse(
    db.querySql<{ metadata_json: string }>(
      `SELECT metadata_json FROM runs WHERE id=${db.sqlValue(jobReference.runId)} LIMIT 1`
    )[0].metadata_json
  ) as Record<string, any>;
  assert.equal(jobReferenceMetadata.portable_workflow_invocation?.read_only_stage, "reference_readback");
  await runWorkerOnce(jobReference.runId);
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
  assert.ok(picked.some((item) => item.runId === started.runId));
  const run = db.querySql<{ status: string; metadata_json: string }>(
    `SELECT status, metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`
  )[0];
  const metadata = JSON.parse(run.metadata_json) as { external_action_executed?: boolean };
  assert.equal(run.status, "blocked");
  assert.equal(metadata.external_action_executed, false);
});

test("Mac worker uses the async boundary for a portable local read-only receipt", async () => {
  const previousRole = process.env.AUTOMATION_OS_WORKER_ROLE;
  const previousRegistry = process.env.AUTOMATION_OS_PROJECT_REGISTRY;
  process.env.AUTOMATION_OS_WORKER_ROLE = "mac";
  // The receipt/async-boundary test must not depend on the host's current
  // projects becoming healthy, or read the user's live registry.
  process.env.AUTOMATION_OS_PROJECT_REGISTRY = join(tempRoot, "missing-async-boundary-registry.json");
  const runId = "portable-local-async-boundary-regression";
  const stepId = `${runId}_step_1`;
  const laneId = `${runId}_lane-1`;
  const now = new Date().toISOString();
  try {
    db.insert("runs", {
      id: runId,
      company_id: "portable_mac_worker_scope",
      name: "Obsidian local read-only async boundary regression",
      status: "queued",
      objective: "Obsidian project memory audit registered workflow read-only",
      created_at: now,
      updated_at: now,
      metadata_json: {
        worker_protocol: "mac_worker_polling_required",
        worker_mode: "queued_for_mac_worker",
        portable_workflow_invocation: { workflow_id: "obsidian-project-memory-audit" },
        plan: { tasks: [{ adapter: "obsidian_audit_registered" }] }
      }
    });
    db.insert("lanes", {
      id: laneId,
      run_id: runId,
      role: "Local Worker",
      cdp_port: 19983,
      profile_dir: "portable-local-async-boundary",
      workdir: process.cwd(),
      status: "active",
      current_task: "Obsidian audit",
      progress: 10,
      health: "good",
      updated_at: now
    });
    db.insert("run_steps", {
      id: stepId,
      run_id: runId,
      company_id: "portable_mac_worker_scope",
      name: "Obsidian local read-only async boundary regression",
      status: "queued",
      lane_id: laneId,
      started_at: null,
      completed_at: null,
      metadata_json: { adapter: "obsidian_audit_registered" }
    });

    const picked = await runPortableMacWorkerOnce(runId);
    assert.ok(picked.some((item) => item.runId === runId));
    const run = db.querySql<{ status: string; metadata_json: string }>(
      `SELECT status, metadata_json FROM runs WHERE id=${db.sqlValue(runId)} LIMIT 1`
    )[0];
    const step = db.querySql<{ status: string; metadata_json: string }>(
      `SELECT status, metadata_json FROM run_steps WHERE id=${db.sqlValue(stepId)} LIMIT 1`
    )[0];
    const proof = db.querySql<{ proof_type: string; metadata_json: string }>(
      `SELECT proof_type, metadata_json FROM proofs WHERE run_id=${db.sqlValue(runId)} LIMIT 1`
    )[0];
    const events = db.querySql<{ event_type: string }>(
      `SELECT event_type FROM worker_events WHERE run_id=${db.sqlValue(runId)} ORDER BY created_at ASC`
    );
    assert.equal(run.status, "blocked");
    assert.equal(step.status, "blocked");
    assert.equal(proof.proof_type, "worker_receipt");
    assert.ok(!JSON.parse(step.metadata_json).exact_blocker?.includes("mac_worker_required"));
    assert.ok(events.some((event) => event.event_type === "worker_blocked"));
  } finally {
    if (previousRole === undefined) delete process.env.AUTOMATION_OS_WORKER_ROLE;
    else process.env.AUTOMATION_OS_WORKER_ROLE = previousRole;
    if (previousRegistry === undefined) delete process.env.AUTOMATION_OS_PROJECT_REGISTRY;
    else process.env.AUTOMATION_OS_PROJECT_REGISTRY = previousRegistry;
  }
});

test("Gmail read-only local starts persist only the exact run-bound target pair", async () => {
  db.initDb();
  const started = await startPortableLocalWorkflowRun({
    workflowId: "email-review-reply",
    sourceTrigger: "automation_os_ui",
    idempotencyKey: "portable-local-gmail-readonly-target-persistence",
    companyId: "portable_gmail_target_scope",
    inputBundle: {
      connection_ref_id: "company_connection_verified",
      account_ref: "mailbox@example.com"
    },
    readOnlyStage: "reference_readback"
  });
  const row = db.querySql<{ metadata_json: string }>(
    `SELECT metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`
  )[0];
  const metadata = JSON.parse(row.metadata_json) as { portable_input_bundle?: { input?: Record<string, unknown> } };
  assert.deepEqual(metadata.portable_input_bundle?.input, {
    connection_ref_id: "company_connection_verified",
    account_ref: "mailbox@example.com"
  });
});

test("async Mac Gmail seam stores only the redacted canary readback and remains partial", async () => {
  const previousRegistryPath = process.env.AUTOMATION_OS_CODEX_APP_SERVER_REGISTRY_READBACK_PATH;
  const registryPath = join(mkdtempSync(join(tmpdir(), "automation-os-gmail-canary-registry-")), "registry.json");
  const companyId = "portable-async-gmail-company";
  const connectionRefId = "portable-async-gmail-ref";
  const accountRef = "owner@example.com";
  const now = new Date().toISOString();
  db.insert("companies", { id: companyId, slug: companyId, name: companyId, status: "active", created_at: now, updated_at: now });
  db.insert("company_connection_account_refs", {
    id: connectionRefId, company_id: companyId, platform: "gmail", account_ref: accountRef, status: "verified",
    scopes_json: JSON.stringify(["read"]), expires_at: null, oauth_state: "connected", verification_status: "verified",
    last_verified_at: now, reconnect_requested_at: null, revoked_at: null, revision: 1, created_at: now, updated_at: now
  });
  writeFileSync(registryPath, JSON.stringify({
    schema: "aos_zeabur_codex_app_server_connector_registry.v1", capturedAt: now, source: "zeabur_service_exec",
    target: { projectId: "p", serviceId: "s", serviceName: "codex-app-server", environmentId: "e" },
    appServer: { servicePresent: true, runtimeStatus: "running", codexLogin: "logged_in" },
    pluginRegistry: { installed: [{ id: "gmail", name: "gmail", installed: true, authStatus: "verified" }], available: [] },
    mcpRegistry: { configuredCount: 1, verified: true, names: ["gmail"] }, connectorAuth: { gmail: "verified" },
    exactBlocker: null, secretMaterialIncluded: false
  }));
  process.env.AUTOMATION_OS_CODEX_APP_SERVER_REGISTRY_READBACK_PATH = registryPath;
  const providerAccountHash = createHash("sha256").update(accountRef).digest("hex");
  const canary = async () => ({
    schema: "aos.gmail_provider_read_only_canary.v1", status: "completed", runId: "async-run", companyId,
    connector: "gmail", operation: "profile_read", transport: "codex_app_server_plugin", providerToolCallObserved: true,
    providerAccountPresent: true, providerAccountHash, exactBlocker: null, nextAction: "profile only",
    externalActionExecuted: false, dataRead: true, dataPersisted: false, secretMaterialIncluded: false,
    providerReceipt: { schema: "aos.gmail.provider_receipt.v1", sameRun: true, runId: "async-run", operation: "profile_read", providerAccountHash, externalActionExecuted: false },
    sourceSync: { status: "verified", accountRefHash: providerAccountHash },
    reconciliation: { required: true, status: "verified", exactBlocker: null }, cleanup: { status: "verified", ephemeralThread: true }
  } as const);
  try {
    const result = await runPortableLocalWorkflowAsync({ workflowId: "email-review-reply", runId: "async-run", workerRole: "mac", companyId,
      gmailExecutionTarget: { connectionRefId, accountRef }, gmailProviderReadOnlyCanary: canary });
    assert.equal(result.status, "partial");
    assert.equal(result.exact_blocker, null);
    assert.equal(result.readback_verified, true);
    assert.equal(result.external_action_executed, false);
    assert.equal(result.business_completion_verified, false);
    assert.equal(JSON.stringify(result).includes(accountRef), false);
    assert.equal((result.adapter_result.gmail_provider_read_only_canary as Record<string, unknown>).providerAccountHash, providerAccountHash);
    const legacy = runPortableLocalWorkflowReadOnly({ workflowId: "email-review-reply", workerRole: "mac", companyId,
      gmailExecutionTarget: { connectionRefId, accountRef } });
    assert.equal(legacy.exact_blocker, "gmail_provider_read_only_call_not_executed");
  } finally {
    if (previousRegistryPath === undefined) delete process.env.AUTOMATION_OS_CODEX_APP_SERVER_REGISTRY_READBACK_PATH;
    else process.env.AUTOMATION_OS_CODEX_APP_SERVER_REGISTRY_READBACK_PATH = previousRegistryPath;
  }
});

test("async Mac Gmail seam blocks canary turn failure without a provider receipt", async () => {
  const result = await runPortableLocalWorkflowAsync({ workflowId: "email-review-reply", workerRole: "remote", companyId: "c1",
    gmailExecutionTarget: { connectionRefId: "ref", accountRef: "owner@example.com" },
    gmailProviderReadOnlyCanary: async () => { throw new Error("gmail_provider_turn_timeout"); } });
  assert.equal(result.status, "blocked");
  assert.equal(result.exact_blocker, "mac_worker_required");
  assert.equal(result.external_action_executed, false);
});

test("portable local worker preserves the Run company scope for adapter readback", async () => {
  const previousRole = process.env.AUTOMATION_OS_WORKER_ROLE;
  const previousRegistryPath = process.env.AUTOMATION_OS_CODEX_APP_SERVER_REGISTRY_READBACK_PATH;
  process.env.AUTOMATION_OS_WORKER_ROLE = "mac";
  process.env.AUTOMATION_OS_CODEX_APP_SERVER_REGISTRY_READBACK_PATH = join(mkdtempSync(join(tmpdir(), "automation-os-missing-registry-")), "missing.json");
  const runId = "portable-local-company-scope-regression";
  const stepId = `${runId}_step_1`;
  const laneId = `${runId}_lane-1`;
  const companyId = "portable-local-company-scope";
  const now = new Date().toISOString();
  try {
    db.insert("runs", {
      id: runId,
      company_id: companyId,
      name: "Email local company scope regression",
      status: "queued",
      objective: "Email review reply registered workflow read-only",
      created_at: now,
      updated_at: now,
      metadata_json: {
        worker_protocol: "mac_worker_polling_required",
        worker_mode: "queued_for_mac_worker",
        portable_workflow_invocation: { workflow_id: "email-review-reply" },
        plan: { tasks: [{ adapter: "email_review_registered" }] }
      }
    });
    db.insert("lanes", {
      id: laneId,
      run_id: runId,
      role: "Local Worker",
      cdp_port: 19984,
      profile_dir: "portable-local-company-scope",
      workdir: process.cwd(),
      status: "active",
      current_task: "Email review",
      progress: 10,
      health: "good",
      updated_at: now
    });
    db.insert("run_steps", {
      id: stepId,
      run_id: runId,
      company_id: companyId,
      name: "Email local company scope regression",
      status: "queued",
      lane_id: laneId,
      started_at: null,
      completed_at: null,
      metadata_json: { adapter: "email_review_registered" }
    });

    const picked = await runPortableMacWorkerOnce(runId);
    assert.equal(picked.length, 1);
    const step = db.querySql<{ metadata_json: string }>(
      `SELECT metadata_json FROM run_steps WHERE id=${db.sqlValue(stepId)} LIMIT 1`
    )[0];
    const receipt = JSON.parse(step.metadata_json).portable_local_receipt as {
      exact_blocker?: string;
      adapter_result?: { company_id?: string };
    };
    assert.notEqual(receipt.exact_blocker, "company_scope_required");
    assert.equal(receipt.adapter_result?.company_id, companyId);
  } finally {
    if (previousRole === undefined) delete process.env.AUTOMATION_OS_WORKER_ROLE;
    else process.env.AUTOMATION_OS_WORKER_ROLE = previousRole;
    if (previousRegistryPath === undefined) delete process.env.AUTOMATION_OS_CODEX_APP_SERVER_REGISTRY_READBACK_PATH;
    else process.env.AUTOMATION_OS_CODEX_APP_SERVER_REGISTRY_READBACK_PATH = previousRegistryPath;
  }
});

test("synchronous runWorkerOnce preserves the Run company scope for local adapters", async () => {
  const previousRole = process.env.AUTOMATION_OS_WORKER_ROLE;
  const previousRegistryPath = process.env.AUTOMATION_OS_CODEX_APP_SERVER_REGISTRY_READBACK_PATH;
  process.env.AUTOMATION_OS_WORKER_ROLE = "mac";
  process.env.AUTOMATION_OS_CODEX_APP_SERVER_REGISTRY_READBACK_PATH = join(mkdtempSync(join(tmpdir(), "automation-os-missing-sync-registry-")), "missing.json");
  try {
    const companyId = "portable-local-sync-company-scope";
    const started = await startPortableLocalWorkflowRun({
      workflowId: "email-review-reply",
      sourceTrigger: "automation_os_scheduler",
      idempotencyKey: "portable-local-sync-company-scope",
      companyId,
      readOnlyStage: "reference_readback"
    });
    const processed = await runWorkerOnce(started.runId);
  assert.equal(processed.length, 1);
    const run = db.querySql<{ status: string; metadata_json: string }>(
      `SELECT status, metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`
    )[0];
    const metadata = JSON.parse(run.metadata_json) as {
      portable_local_worker?: {
        receipt?: { exact_blocker?: string; adapter_result?: { company_id?: string } };
      };
    };
    assert.equal(run.status, "blocked");
    assert.notEqual(metadata.portable_local_worker?.receipt?.exact_blocker, "company_scope_required");
    assert.equal(metadata.portable_local_worker?.receipt?.adapter_result?.company_id, companyId);
  } finally {
    if (previousRole === undefined) delete process.env.AUTOMATION_OS_WORKER_ROLE;
    else process.env.AUTOMATION_OS_WORKER_ROLE = previousRole;
    if (previousRegistryPath === undefined) delete process.env.AUTOMATION_OS_CODEX_APP_SERVER_REGISTRY_READBACK_PATH;
    else process.env.AUTOMATION_OS_CODEX_APP_SERVER_REGISTRY_READBACK_PATH = previousRegistryPath;
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
  const expectedInputBundle = inputBundle;
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
  assert.deepEqual(bundle.input, expectedInputBundle);
  const run = db.querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`)[0];
  const metadata = JSON.parse(run.metadata_json) as { portable_input_bundle?: { path?: string; sha256?: string; created_at?: string; input?: typeof inputBundle }; portable_workflow_invocation?: { input_bundle_path?: string } };
  assert.equal(metadata.portable_input_bundle?.path, bundlePath);
  assert.equal(metadata.portable_workflow_invocation?.input_bundle_path, bundlePath);
  assert.deepEqual(metadata.portable_input_bundle?.input, expectedInputBundle);
  assert.match(String(metadata.portable_input_bundle?.sha256 || ""), /^[a-f0-9]{64}$/u);
  assert.match(String(metadata.portable_input_bundle?.created_at || ""), /^202\d-/u);
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

test("Mac worker copies the canonical input bundle bytes when the worker artifact root differs", () => {
  const runId = "run_portable_input_bundle_cross_root_binding";
  const sourcePath = join(tempRoot, "canonical-input-bundle.json");
  const input = {
    source_snapshot_id: "snapshot-cross-root-binding",
    supply_run_id: "supply-cross-root-binding",
    bucket: "overseas_global",
    sequence: 1,
    attempt: 1,
    company: "Example",
    role: "Example role",
    payload_hash: "a".repeat(64),
  };
  const sourceBytes = `${JSON.stringify({
    schema: "automation_os_portable_workflow_input_bundle.v1",
    workflow_id: "job-application-manager",
    run_id: runId,
    input,
    created_at: "2026-08-17T00:00:00.000Z",
  }, null, 2)}\n`;
  writeFileSync(sourcePath, sourceBytes, { mode: 0o600 });
  chmodSync(sourcePath, 0o600);
  const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  const copiedPath = materializePortableInputBundleForMacWorker({
    runId,
    workflowId: "job-application-manager",
    input,
    sourceBundlePath: sourcePath,
    sourceBundleSha256: sourceSha256,
  });
  assert.equal(readFileSync(copiedPath, "utf8"), sourceBytes);
  assert.equal(createHash("sha256").update(readFileSync(copiedPath)).digest("hex"), sourceSha256);
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
        account_ref: "linkedin_authenticated_job_manager",
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
        payload_hash: "a".repeat(64),
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
    const metadata = JSON.parse(run.metadata_json) as {
      portable_target_bound_approval_binding?: Record<string, unknown>;
      portable_target_bound_approval_receipt?: Record<string, unknown>;
      worker_protocol?: string;
      worker_mode?: string;
      web_operation_backend?: {
        route_decision_schema?: string;
        resolved_backend?: string;
        route_reason?: string;
        route_admission_status?: string;
        route_frozen_after_dispatch?: boolean;
      };
    };
    assert.equal(metadata.worker_protocol, "mac_worker_polling_required");
    assert.equal(metadata.worker_mode, "queued_for_mac_worker");
    assert.equal(metadata.web_operation_backend?.route_decision_schema, "browser_route_decision.v2");
    assert.equal(metadata.web_operation_backend?.resolved_backend, "aos_chrome_companion");
    assert.equal(metadata.web_operation_backend?.route_reason, "companion_effect_adapter_available");
    assert.equal(metadata.web_operation_backend?.route_admission_status, "ready");
    assert.equal(metadata.web_operation_backend?.route_frozen_after_dispatch, true);
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
    const companionStarted = await startPortableWorkflowRun({
        workflowId: "job-application-manager",
        sourceTrigger: "automation_os_ui",
        idempotencyKey: "portable-business-companion-effect-blocked",
        companyId: "portable_business_admission_scope",
        effectStage: "one_candidate_submit",
        browserSurfaceRequirement: "companion_extension",
        inputBundle: {
          account_ref: "linkedin_authenticated_job_manager",
          job_url: "https://example.com/jobs/companion-effect-blocked",
          application_url: "https://example.com/jobs/companion-effect-blocked",
          candidate_key: "candidate-companion-effect-blocked",
          bucket: "japan_targeted",
          sequence: 2,
          attempt: 1,
          source_snapshot_id: "snapshot-companion-effect-blocked",
          supply_run_id: "supply-companion-effect-blocked",
          company: "Example Company",
          role: "Marketing Manager",
          payload_hash: "b".repeat(64),
        },
      });
    assert.equal(companionStarted.status, "waiting_approval");
    const companionRun = db.querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(companionStarted.runId)} LIMIT 1`)[0];
    const companionMetadata = JSON.parse(companionRun.metadata_json) as { web_operation_backend?: { resolved_backend?: string; route_reason?: string } };
    assert.equal(companionMetadata.web_operation_backend?.resolved_backend, "aos_chrome_companion");
    assert.equal(companionMetadata.web_operation_backend?.route_reason, "companion_extension_explicitly_required");
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

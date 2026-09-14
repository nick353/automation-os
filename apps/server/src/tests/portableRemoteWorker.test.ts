import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-portable-remote-worker-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");
process.env.AUTOMATION_OS_ARTIFACT_ROOT = join(tempRoot, "artifacts");
process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = "canary";
process.env.AOS_WEB_OPERATION_BACKEND_CONFIG = join(tempRoot, "web-operation-backend.json");

const db = await import("../db/client.js");
const { initRegisteredWorkflows } = await import("../registeredWorkflows.js");
const { startPortableLocalWorkflowRun } = await import("../runs/portableLocalWorkflowEntrypoint.js");
const { startPortableWorkflowRun } = await import("../runs/portableWorkflowEntrypoint.js");
const dailyAi = await import("../runs/dailyAiResearchSourceSync.js");
const {
  claimPortableMacWorker,
  claimPortableMacWorkerAsync,
  claimPortableBackupPostEffectReconciliationAsync,
  recordPortableBackupPostEffectEvidenceAsync,
  recordPortableMacWorkerReceipt,
  recordPortableMacWorkerReceiptAsync,
  requeuePortableMacWorkerAfterApproval,
  requeuePortableMacWorkerAfterApprovalAsync,
  reconcileStalePortablePreparingRunsAsync,
  businessProofSatisfied,
  validSafeCompanionToOfficialHandoff,
  validBlockedSafeCompanionToOfficialHandoff
} = await import("../runs/portableRemoteWorker.js");
const { readPortableRunRecovery, requestPortableBackupPostEffectReconciliation } = await import("../runs/portableRunRecovery.js");

// Keep the pre-existing Browser Use CLI receipt fixtures explicit. The live
// application default is Chrome Plugin; the dedicated regression below
// overrides a run snapshot to exercise that lane.
db.initDb();
db.execSql(`INSERT OR REPLACE INTO web_operation_settings
  (id, backend, revision, chrome_profile_id, chrome_profile_name, chrome_profile_directory, chrome_surface, updated_at, updated_by)
  VALUES ('global', 'browser_use_cli', 1, 'profile2', 'Profile 2', 'Profile 2', 'signed_chrome_extension_profile2', '2026-01-01T00:00:00.000Z', 'portable-remote-worker-test');`);

function effectAuthoritySha256(value: unknown): string {
  return createHash("sha256").update(`${JSON.stringify(value, null, 2)}\n`).digest("hex");
}

test("server admits only a complete signed-shape Companion-to-official no-effect handoff", () => {
  const input = {
    browser_surface: "signed_chrome_extension_profile2",
    external_action_executed: false,
    visual_readback_verified: true,
    safe_surface_handoff: {
      schema: "aos.safe_extension_surface_handoff.v1",
      status: "completed",
      direction: "one_way",
      source_backend: "aos_chrome_companion",
      source_surface: "aos_chrome_companion_profile_instance",
      destination_backend: "chrome_plugin",
      destination_surface: "signed_chrome_extension_profile2",
      handoff_count: 1,
      max_handoffs: 1,
      external_action_executed: false,
      replay_allowed: false,
      source_no_effect_verified: true,
      source_cleanup_verified: true,
      destination_visual_verified: true,
      destination_cleanup_verified: true,
      destination_readback_verified: true,
    },
  };
  const expected = { executionMode: "read_only" as const, browserSurface: "aos_chrome_companion_profile_instance" as const };
  assert.equal(validSafeCompanionToOfficialHandoff(input, expected), true);
  assert.equal(validSafeCompanionToOfficialHandoff({
    ...input,
    safe_surface_handoff: { ...input.safe_surface_handoff, source_no_effect_verified: false },
  }, expected), false);
  assert.equal(validSafeCompanionToOfficialHandoff({ ...input, visual_readback_verified: false }, expected), false);
});

test("server preserves a blocked no-effect handoff receipt for terminal reconciliation", () => {
  const input = {
    status: "blocked",
    browser_surface: "signed_chrome_extension_profile2",
    external_action_executed: false,
    visual_readback_verified: false,
    source_surface_receipt: {
      external_action_executed: false,
      mutation_dispatch_attempted: false,
      mutation_dispatch_count: 0,
      operation_effect_state: "none",
      reconciliation_required: false,
      cleanup_verified: true,
    },
    safe_surface_handoff: {
      schema: "aos.safe_extension_surface_handoff.v1",
      status: "blocked",
      direction: "one_way",
      source_backend: "aos_chrome_companion",
      source_surface: "aos_chrome_companion_profile_instance",
      destination_backend: "chrome_plugin",
      destination_surface: "signed_chrome_extension_profile2",
      handoff_count: 1,
      max_handoffs: 1,
      external_action_executed: false,
      replay_allowed: false,
      source_no_effect_verified: true,
      source_cleanup_verified: true,
      destination_visual_verified: false,
      destination_cleanup_verified: false,
      destination_readback_verified: false,
    },
  };
  const expected = { executionMode: "read_only" as const, browserSurface: "aos_chrome_companion_profile_instance" as const };
  assert.equal(validBlockedSafeCompanionToOfficialHandoff(input, expected), true);
  assert.equal(validBlockedSafeCompanionToOfficialHandoff({
    ...input,
    source_surface_receipt: { ...input.source_surface_receipt, operation_effect_state: "unknown" },
  }, expected), false);
});

function ensureTestCompany(companyId: string): void {
  db.execSql(`INSERT OR IGNORE INTO companies (id, slug, name, status, created_at, updated_at)
              VALUES (${db.sqlValue(companyId)}, ${db.sqlValue(companyId)}, ${db.sqlValue(companyId)}, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');`);
}

function businessLifecycle(claim: {
  workflow_id: string;
  run_id: string;
  step_id: string;
  idempotency_key: string;
  target_digest: string | null;
  effect_authority: { payload_hash?: string | null } | null;
}, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "automation_os_web_operation_lifecycle.v1",
    state: "cleaned",
    status: "complete",
    exact_blocker: null,
    restart_point: null,
    run_id: claim.run_id,
    step_id: claim.step_id,
    idempotency_key: claim.idempotency_key,
    operation: claim.workflow_id === "job-application-manager" ? "submit" : "publish",
    target_digest: claim.target_digest,
    payload_hash: claim.effect_authority?.payload_hash ?? null,
    external_action_executed: true,
    same_run_receipt: true,
    readback_verified: true,
    cleanup_verified: true,
    no_replay: true,
    ...overrides,
  };
}

test("remote Mac worker claim and receipt stay Company-scoped, idempotent, and read-only", async () => {
  db.initDb();
  initRegisteredWorkflows();
  const companyId = "portable_remote_worker_test_company";
  ensureTestCompany(companyId);
  const workerId = "mac-remote-worker-regression";
  const started = await startPortableWorkflowRun({
    workflowId: "job-application-manager",
    sourceTrigger: "automation_os_scheduler",
    idempotencyKey: "portable-remote-worker-regression",
    browserSurfaceRequirement: "browser_use_cli",
    companyId,
    readOnlyStage: "candidate_supply",
    inputBundle: {
      source_snapshot_id: "snapshot-remote-worker-regression",
      supply_run_id: "supply-remote-worker-regression",
      bucket: "japan_targeted",
      remaining: 0,
      margin: 0,
    },
  });

  const claim = claimPortableMacWorker({ companyId, workerId, requestedRunId: started.runId });
  assert.ok(claim);
  assert.equal(claim.run_id, started.runId);
  assert.equal(claim.company_id, companyId);
  assert.equal(claim.read_only_stage, "candidate_supply");
  assert.equal(claim.browser_surface, "browser_use_cli");
  assert.equal(claim.external_action_executed, false);

  const replayedClaim = claimPortableMacWorker({ companyId, workerId, requestedRunId: started.runId });
  assert.deepEqual(replayedClaim, claim);

  const receipt = recordPortableMacWorkerReceipt({
    companyId,
    workerId,
    runId: claim.run_id,
    receipt: {
      status: "complete",
      exact_blocker: null,
      external_action_executed: false,
      browser_surface: "browser_use_cli",
      workflow_id: claim.workflow_id,
      run_id: claim.run_id,
      step_id: claim.step_id,
      cleanup_verified: true,
      readback_verified: true,
      effects_mode: "read_only",
      read_only_stage_bound: true,
      same_run_receipt: true,
      external_executor_status: "candidate_supply_readback",
      adapter_result: {
        stage: "job_candidate_supply",
        status: "ready",
        ready: true,
        read_only: true,
        candidate_count: 1,
        requested_count: 1,
        artifact_uri: "file:///redacted/candidate.json",
        browser_authority_path: "file:///redacted/authority.json",
        browser_flow_receipt_path: "file:///redacted/flow-receipt.json",
        browser_flow_manifest_path: "file:///redacted/manifest.json",
        cleanup_verified: true,
        browser_flow_status: "finalized",
        browser_runtime_readback: {
          requested_session: "aos-requested-session",
          effective_session: "aos-effective-session",
          profile_root: "/Users/nichikatanaka/.browser-use-cli/profiles/scheduled/automation-3",
          reserved_port: 19881,
          flow_status: "finalized",
          cleanup_verified: true,
        },
      },
    },
  });
  assert.equal(receipt.replayed, false);
  assert.equal(receipt.receipt.external_action_executed, false);
  assert.equal(receipt.receipt.exact_blocker, null);
  assert.equal(receipt.receipt.read_only_proof_verified, true);
  assert.match(receipt.artifact_uri, new RegExp(`^/api/v1/companies/${companyId}/artifacts/artifact_`));
  const storedProof = db.querySql<{ artifact_id: string; uri: string }>(
    `SELECT artifact_id, uri FROM proofs WHERE run_id=${db.sqlValue(started.runId)} ORDER BY created_at DESC LIMIT 1`,
  )[0];
  assert.equal(storedProof.artifact_id, receipt.artifact_uri.split("/").pop());
  assert.equal(storedProof.uri, receipt.artifact_uri);
  const storedArtifact = db.querySql<{ status: string; checksum_sha256: string; size_bytes: number; content_text: string }>(
    `SELECT status, checksum_sha256, size_bytes, content_text FROM run_artifacts WHERE id=${db.sqlValue(storedProof.artifact_id)} LIMIT 1`,
  )[0];
  assert.equal(storedArtifact.status, "available");
  assert.equal(storedArtifact.checksum_sha256, createHash("sha256").update(storedArtifact.content_text).digest("hex"));
  assert.equal(storedArtifact.size_bytes, Buffer.byteLength(storedArtifact.content_text));

  const receiptReplay = recordPortableMacWorkerReceipt({
    companyId,
    workerId,
    runId: claim.run_id,
    receipt: {
      status: "complete",
      exact_blocker: null,
      external_action_executed: false,
      browser_surface: "browser_use_cli",
      workflow_id: claim.workflow_id,
      run_id: claim.run_id,
      step_id: claim.step_id,
      cleanup_verified: true,
      readback_verified: true,
      effects_mode: "read_only",
      read_only_stage_bound: true,
      external_executor_status: "candidate_supply_readback",
    },
  });
  assert.equal(receiptReplay.replayed, true);

  const run = db.querySql<{ status: string; company_id: string; metadata_json: string }>(
    `SELECT status, company_id, metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`,
  )[0];
  const metadata = JSON.parse(run.metadata_json) as { external_action_executed?: boolean; exact_blocker?: string };
  assert.equal(run.status, "complete");
  assert.equal(run.company_id, companyId);
  assert.equal(metadata.external_action_executed, false);
  assert.equal(metadata.exact_blocker, null);
  const stepMetadata = JSON.parse(db.querySql<{ metadata_json: string }>(
    `SELECT metadata_json FROM run_steps WHERE run_id=${db.sqlValue(started.runId)} ORDER BY id ASC LIMIT 1`,
  )[0].metadata_json) as { service_readiness_runtime_binding?: Record<string, unknown> };
  assert.equal(stepMetadata.service_readiness_runtime_binding?.effective_session_id, "aos-effective-session");
  assert.equal(stepMetadata.service_readiness_runtime_binding?.reserved_port, 19881);
  assert.equal(stepMetadata.service_readiness_runtime_binding?.readback_status, "verified");
  assert.equal(stepMetadata.service_readiness_runtime_binding?.status, "verified");
});

test("a restarted worker instance cannot inherit a live claim from the prior process", async () => {
  const companyId = "portable_remote_worker_instance_fence_company";
  ensureTestCompany(companyId);
  const workerId = "mac-worker-instance-fence";
  const started = await startPortableWorkflowRun({
    workflowId: "job-application-manager",
    sourceTrigger: "automation_os_scheduler",
    idempotencyKey: "portable-remote-worker-instance-fence",
    companyId,
    readOnlyStage: "candidate_supply",
    inputBundle: {
      source_snapshot_id: "snapshot-worker-instance-fence",
      supply_run_id: "supply-worker-instance-fence",
      bucket: "japan_targeted",
      remaining: 0,
      margin: 0,
    },
  });

  const firstClaim = claimPortableMacWorker({
    companyId,
    workerId,
    workerInstanceId: "instance-first-process",
    requestedRunId: started.runId,
  });
  assert.ok(firstClaim);
  assert.equal(firstClaim.worker_instance_id, "instance-first-process");

  const restartedClaim = claimPortableMacWorker({
    companyId,
    workerId,
    workerInstanceId: "instance-restarted-process",
    requestedRunId: started.runId,
  });
  assert.equal(restartedClaim, null);
  assert.equal(
    db.querySql<{ status: string }>(`SELECT status FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`)[0].status,
    "running",
  );
});

test("portable Mac claim carries the fresh Chrome Plugin Profile 2 backend into the worker lane", async () => {
  const companyId = "portable_remote_chrome_plugin_claim_company";
  ensureTestCompany(companyId);
  const started = await startPortableWorkflowRun({
    workflowId: "job-application-manager",
    sourceTrigger: "automation_os_scheduler",
    idempotencyKey: "portable-remote-chrome-plugin-claim-regression",
    companyId,
    readOnlyStage: "candidate_supply",
    inputBundle: {
      source_snapshot_id: "snapshot-chrome-plugin-claim-regression",
      supply_run_id: "supply-chrome-plugin-claim-regression",
      bucket: "japan_targeted",
      remaining: 0,
      margin: 0,
    },
  });
  const stored = db.querySql<{ metadata_json: string }>(
    `SELECT metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`,
  )[0];
  const metadata = JSON.parse(stored.metadata_json) as Record<string, unknown>;
  db.execSql(`UPDATE runs SET metadata_json=${db.sqlValue({
    ...metadata,
    web_operation_backend: {
      requested_backend: "chrome_plugin",
      resolved_backend: "chrome_plugin",
      revision: 7,
      source: "aos_global_setting",
      fallback_allowed: false,
      browser_surface: "signed_chrome_extension_profile2",
      chrome_profile: {
        id: "profile2",
        name: "Profile 2",
        directory: "Profile 2",
        surface: "signed_chrome_extension_profile2",
      },
    },
  })} WHERE id=${db.sqlValue(started.runId)};`);

  const claim = claimPortableMacWorker({ companyId, workerId: "mac-chrome-plugin-claim-regression", requestedRunId: started.runId });
  assert.ok(claim);
  assert.equal(claim.browser_surface, "signed_chrome_extension_profile2");
  assert.equal(claim.web_operation_backend?.resolved_backend, "chrome_plugin");
  assert.equal(claim.web_operation_backend?.source, "aos_global_setting");
  assert.equal(claim.web_operation_backend?.fallback_allowed, false);
  assert.equal(claim.web_operation_backend?.browser_surface, "signed_chrome_extension_profile2");
  assert.equal((claim.web_operation_backend?.chrome_profile as Record<string, unknown>)?.directory, "Profile 2");

  const receipt = recordPortableMacWorkerReceipt({
    companyId,
    workerId: "mac-chrome-plugin-claim-regression",
    runId: started.runId,
    receipt: {
      status: "blocked",
      exact_blocker: "chrome_plugin_probe_blocked",
      external_action_executed: false,
      browser_surface: "signed_chrome_extension_profile2",
      workflow_id: claim.workflow_id,
      run_id: claim.run_id,
      step_id: claim.step_id,
      cleanup_verified: true,
      readback_verified: false,
      effects_mode: "read_only",
      read_only_stage_bound: true,
      same_run_receipt: false,
      external_executor_status: "chrome_plugin_probe",
    },
  });
  assert.equal(receipt.receipt.browser_surface, "signed_chrome_extension_profile2");
  assert.equal(receipt.receipt.exact_blocker, "chrome_plugin_probe_blocked");
});

test("read-only completion remains blocked when the candidate artifact proof is incomplete", async () => {
  const companyId = "portable_remote_read_only_proof_regression_company";
  ensureTestCompany(companyId);
  const started = await startPortableWorkflowRun({
    workflowId: "job-application-manager",
    sourceTrigger: "automation_os_scheduler",
    idempotencyKey: "portable-remote-read-only-proof-regression",
    browserSurfaceRequirement: "browser_use_cli",
    companyId,
    readOnlyStage: "candidate_supply",
    inputBundle: {
      source_snapshot_id: "snapshot-read-only-proof-regression",
      supply_run_id: "supply-read-only-proof-regression",
      bucket: "japan_targeted",
      remaining: 1,
      margin: 0,
    },
  });
  const claim = claimPortableMacWorker({ companyId, workerId: "mac-read-only-proof-regression", requestedRunId: started.runId });
  assert.ok(claim);
  const receipt = recordPortableMacWorkerReceipt({
    companyId,
    workerId: "mac-read-only-proof-regression",
    runId: started.runId,
    receipt: {
      status: "complete",
      exact_blocker: null,
      external_action_executed: false,
      browser_surface: "browser_use_cli",
      workflow_id: claim.workflow_id,
      run_id: claim.run_id,
      step_id: claim.step_id,
      cleanup_verified: true,
      readback_verified: true,
      effects_mode: "read_only",
      read_only_stage_bound: true,
      external_executor_status: "candidate_supply_readback",
      adapter_result: { stage: "job_candidate_supply", status: "ready", ready: true, read_only: true },
    },
  });
  assert.equal(receipt.receipt.status, "complete");
  assert.equal(receipt.receipt.exact_blocker, "portable_remote_read_only_business_completion_proof_pending");
  assert.equal(receipt.receipt.read_only_proof_verified, false);
  assert.equal(db.querySql<{ status: string }>(`SELECT status FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`)[0].status, "blocked");
});

test("Chrome Plugin candidate-supply proof completes with same-run cleanup and backend binding", async () => {
  const companyId = "portable_remote_chrome_plugin_proof_company";
  ensureTestCompany(companyId);
  const started = await startPortableWorkflowRun({
    workflowId: "job-application-manager",
    sourceTrigger: "automation_os_ui",
    idempotencyKey: "portable-remote-chrome-plugin-proof-regression",
    companyId,
    readOnlyStage: "candidate_supply",
    inputBundle: {
      source_snapshot_id: "snapshot-chrome-plugin-proof-regression",
      supply_run_id: "supply-chrome-plugin-proof-regression",
      bucket: "japan_targeted",
      remaining: 0,
      margin: 1,
    },
  });
  const stored = db.querySql<{ metadata_json: string }>(
    `SELECT metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`,
  )[0];
  const metadata = JSON.parse(stored.metadata_json) as Record<string, unknown>;
  const backendSnapshot = {
    schema: "aos_web_operation_backend_snapshot.v1",
    requested_backend: "chrome_plugin",
    resolved_backend: "chrome_plugin",
    revision: 19,
    source: "aos_global_setting",
    fallback_allowed: false,
    chrome_profile: {
      id: "profile2",
      name: "Profile 2",
      directory: "Profile 2",
      surface: "signed_chrome_extension_profile2",
    },
    browser_surface: "signed_chrome_extension_profile2",
    exact_blocker: null,
  };
  db.execSql(`UPDATE runs SET metadata_json=${db.sqlValue({
    ...metadata,
    web_operation_backend: backendSnapshot,
  })} WHERE id=${db.sqlValue(started.runId)};`);
  const claim = claimPortableMacWorker({
    companyId,
    workerId: "mac-chrome-plugin-proof-regression",
    requestedRunId: started.runId,
  });
  assert.ok(claim);
  const receipt = recordPortableMacWorkerReceipt({
    companyId,
    workerId: "mac-chrome-plugin-proof-regression",
    runId: started.runId,
    receipt: {
      status: "complete",
      exact_blocker: null,
      external_action_executed: false,
      browser_surface: "signed_chrome_extension_profile2",
      workflow_id: claim.workflow_id,
      run_id: claim.run_id,
      step_id: claim.step_id,
      cleanup_verified: true,
      readback_verified: true,
      effects_mode: "read_only",
      read_only_stage_bound: true,
      same_run_receipt: true,
      external_executor_status: "chrome_plugin_candidate_supply_completed",
      adapter_result: {
        status: "ready",
        read_only: true,
        browser_backend: "chrome_plugin",
        browser_surface: "signed_chrome_extension_profile2",
        candidate_count: 7,
        requested_count: 1,
        artifact_uri: "file:///redacted/chrome-plugin-candidate.json",
        bridge_receipt_path: "file:///redacted/chrome-plugin-bridge-receipt.json",
        bridge_instance_id: "bridge-proof-regression",
        web_operation_backend_snapshot: backendSnapshot,
        tab_cleanup: { ok: true, cleanup_failed: false, tabs_closed: [], tabs_kept: [] },
        cleanup_verified: true,
        readback_verified: true,
      },
    },
  });
  assert.equal(receipt.receipt.status, "complete");
  assert.equal(receipt.receipt.exact_blocker, null);
  assert.equal(receipt.receipt.read_only_proof_verified, true);
  assert.equal(db.querySql<{ status: string }>(`SELECT status FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`)[0].status, "complete");
});

test("Chrome Plugin reference-readback proof completes without business proof", async () => {
  const companyId = "portable_remote_chrome_plugin_reference_company";
  ensureTestCompany(companyId);
  const started = await startPortableWorkflowRun({
    workflowId: "job-application-manager",
    sourceTrigger: "automation_os_ui",
    idempotencyKey: "portable-remote-chrome-plugin-reference-regression",
    companyId,
    readOnlyStage: "reference_readback",
  });
  const stored = db.querySql<{ metadata_json: string }>(
    `SELECT metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`,
  )[0];
  const metadata = JSON.parse(stored.metadata_json) as Record<string, unknown>;
  const backendSnapshot = {
    schema: "aos_web_operation_backend_snapshot.v1",
    requested_backend: "chrome_plugin",
    resolved_backend: "chrome_plugin",
    revision: 26,
    source: "aos_global_setting",
    fallback_allowed: false,
    chrome_profile: {
      id: "profile2",
      name: "Profile 2",
      directory: "Profile 2",
      surface: "signed_chrome_extension_profile2",
    },
    browser_surface: "signed_chrome_extension_profile2",
    exact_blocker: null,
  };
  db.execSql(`UPDATE runs SET metadata_json=${db.sqlValue({
    ...metadata,
    web_operation_backend: backendSnapshot,
  })} WHERE id=${db.sqlValue(started.runId)};`);
  const claim = claimPortableMacWorker({
    companyId,
    workerId: "mac-chrome-plugin-reference-regression",
    requestedRunId: started.runId,
  });
  assert.ok(claim);
  const receipt = recordPortableMacWorkerReceipt({
    companyId,
    workerId: "mac-chrome-plugin-reference-regression",
    runId: started.runId,
    receipt: {
      status: "complete",
      // Reproduce a receipt emitted by the previous verifier generation: the
      // Chrome Plugin terminal evidence is complete, but the generic pending
      // blocker was attached at the outer receipt boundary.
      exact_blocker: "portable_remote_read_only_business_completion_proof_pending",
      external_action_executed: false,
      browser_surface: "signed_chrome_extension_profile2",
      workflow_id: claim.workflow_id,
      run_id: claim.run_id,
      step_id: claim.step_id,
      cleanup_verified: true,
      readback_verified: true,
      effects_mode: "read_only",
      read_only_stage_bound: true,
      same_run_receipt: true,
      external_executor_status: "chrome_plugin_read_only_readback_completed",
      adapter_result: {
        status: "complete",
        operation: "read",
        browser_backend: "chrome_plugin",
        browser_surface: "signed_chrome_extension_profile2",
        requested_origin: "https://www.linkedin.com",
        observed_origin: "https://www.linkedin.com",
        hydration_ready: true,
        bridge_receipt_path: "file:///redacted/chrome-plugin-bridge-receipt.json",
        bridge_instance_id: "bridge-reference-regression",
        web_operation_backend_snapshot: backendSnapshot,
        tab_cleanup: { ok: true, cleanup_failed: false, tabs_closed: ["owned-tab"] },
        cleanup_verified: true,
        readback_verified: true,
      },
    },
  });
  assert.equal(receipt.receipt.status, "complete");
  assert.equal(receipt.receipt.exact_blocker, null);
  assert.equal(receipt.receipt.read_only_proof_verified, true);
  assert.equal(receipt.receipt.business_proof_verified, false);
  assert.equal(db.querySql<{ status: string }>(`SELECT status FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`)[0].status, "complete");
});

test("Chrome Plugin reference proof accepts the legacy outer bridge receipt path", async () => {
  const companyId = "portable_remote_chrome_plugin_outer_receipt_path_company";
  ensureTestCompany(companyId);
  const started = await startPortableWorkflowRun({
    workflowId: "job-application-manager",
    sourceTrigger: "automation_os_ui",
    idempotencyKey: "portable-remote-chrome-plugin-outer-receipt-path-regression",
    companyId,
    readOnlyStage: "reference_readback",
  });
  const stored = db.querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`)[0];
  const metadata = JSON.parse(stored.metadata_json) as Record<string, unknown>;
  const backendSnapshot = {
    schema: "aos_web_operation_backend_snapshot.v1",
    requested_backend: "chrome_plugin",
    resolved_backend: "chrome_plugin",
    revision: 30,
    source: "aos_global_setting",
    fallback_allowed: false,
    chrome_profile: { id: "profile2", name: "Profile 2", directory: "Profile 2", surface: "signed_chrome_extension_profile2" },
    browser_surface: "signed_chrome_extension_profile2",
    exact_blocker: null,
  };
  db.execSql(`UPDATE runs SET metadata_json=${db.sqlValue({ ...metadata, web_operation_backend: backendSnapshot })} WHERE id=${db.sqlValue(started.runId)};`);
  const claim = claimPortableMacWorker({ companyId, workerId: "mac-chrome-plugin-outer-receipt-path-regression", requestedRunId: started.runId });
  assert.ok(claim);
  const receipt = recordPortableMacWorkerReceipt({
    companyId,
    workerId: "mac-chrome-plugin-outer-receipt-path-regression",
    runId: started.runId,
    receipt: {
      status: "complete",
      exact_blocker: null,
      external_action_executed: false,
      browser_surface: "signed_chrome_extension_profile2",
      workflow_id: claim.workflow_id,
      run_id: claim.run_id,
      step_id: claim.step_id,
      cleanup_verified: true,
      readback_verified: true,
      effects_mode: "read_only",
      read_only_stage_bound: true,
      same_run_receipt: true,
      bridge_receipt_path: "file:///redacted/outer-chrome-plugin-receipt.json",
      external_executor_status: "chrome_plugin_read_only_readback_completed",
      adapter_result: {
        status: "complete",
        operation: "read",
        browser_backend: "chrome_plugin",
        browser_surface: "signed_chrome_extension_profile2",
        requested_origin: "https://x.com",
        observed_origin: "https://x.com",
        hydration_ready: true,
        bridge_instance_id: "bridge-outer-receipt-path",
        web_operation_backend_snapshot: backendSnapshot,
        tab_cleanup: { ok: true, tabs_closed: ["owned-tab"], tabs_kept: [] },
        cleanup_verified: true,
        readback_verified: true,
      },
    },
  });
  assert.equal(receipt.receipt.status, "complete");
  assert.equal(receipt.receipt.exact_blocker, null);
  assert.equal(receipt.receipt.read_only_proof_verified, true);
});

test("PostgreSQL-safe portable receipt path persists a fresh read-only Chrome Plugin receipt asynchronously", async () => {
  const companyId = "portable_remote_chrome_plugin_async_receipt_company";
  ensureTestCompany(companyId);
  const started = await startPortableWorkflowRun({
    workflowId: "job-application-manager",
    sourceTrigger: "automation_os_ui",
    idempotencyKey: "portable-remote-chrome-plugin-async-receipt-regression",
    companyId,
    readOnlyStage: "reference_readback",
  });
  const stored = db.querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`)[0];
  const metadata = JSON.parse(stored.metadata_json) as Record<string, unknown>;
  const backendSnapshot = {
    schema: "aos_web_operation_backend_snapshot.v1",
    requested_backend: "chrome_plugin",
    resolved_backend: "chrome_plugin",
    revision: 26,
    source: "aos_global_setting",
    fallback_allowed: false,
    chrome_profile: { id: "profile2", name: "Profile 2", directory: "Profile 2", surface: "signed_chrome_extension_profile2" },
    browser_surface: "signed_chrome_extension_profile2",
    exact_blocker: null,
  };
  db.execSql(`UPDATE runs SET metadata_json=${db.sqlValue({ ...metadata, web_operation_backend: backendSnapshot })} WHERE id=${db.sqlValue(started.runId)};`);
  const claim = claimPortableMacWorker({ companyId, workerId: "mac-chrome-plugin-async-receipt-regression", requestedRunId: started.runId });
  assert.ok(claim);
  const result = await recordPortableMacWorkerReceiptAsync({
    companyId,
    workerId: "mac-chrome-plugin-async-receipt-regression",
    runId: started.runId,
    receipt: {
      status: "complete",
      exact_blocker: null,
      external_action_executed: false,
      browser_surface: "signed_chrome_extension_profile2",
      workflow_id: claim.workflow_id,
      run_id: claim.run_id,
      step_id: claim.step_id,
      cleanup_verified: true,
      readback_verified: true,
      effects_mode: "read_only",
      read_only_stage_bound: true,
      same_run_receipt: true,
      external_executor_status: "chrome_plugin_async_readback_completed",
      adapter_result: {
        status: "complete",
        operation: "read",
        browser_backend: "chrome_plugin",
        browser_surface: "signed_chrome_extension_profile2",
        requested_origin: "https://www.linkedin.com",
        observed_origin: "https://www.linkedin.com",
        hydration_ready: true,
        bridge_receipt_path: "file:///redacted/chrome-plugin-bridge-receipt.json",
        bridge_instance_id: "bridge-async-receipt-regression",
        web_operation_backend_snapshot: backendSnapshot,
        tab_cleanup: { ok: true, cleanup_failed: false, tabs_closed: ["owned-tab"] },
        cleanup_verified: true,
        readback_verified: true,
      },
    },
  });
  assert.equal(result.replayed, false);
  assert.equal(result.receipt.read_only_proof_verified, true);
  assert.match(result.artifact_uri, new RegExp(`^/api/v1/companies/${companyId}/artifacts/artifact_`));
  const asyncProof = db.querySql<{ artifact_id: string; uri: string }>(
    `SELECT artifact_id, uri FROM proofs WHERE run_id=${db.sqlValue(started.runId)} ORDER BY created_at DESC LIMIT 1`,
  )[0];
  assert.equal(asyncProof.artifact_id, result.artifact_uri.split("/").pop());
  assert.equal(asyncProof.uri, result.artifact_uri);
  assert.equal(db.querySql<{ count: number }>(
    `SELECT count(*) AS count FROM run_artifacts WHERE id=${db.sqlValue(asyncProof.artifact_id)} AND run_id=${db.sqlValue(started.runId)} AND company_id=${db.sqlValue(companyId)} AND status='available'`,
  )[0].count, 1);
  assert.equal(db.querySql<{ status: string }>(`SELECT status FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`)[0].status, "complete");
});

test("verified read-only receipt reconciliation preserves terminal run completion", async () => {
  const companyId = "portable_remote_read_only_reconcile_complete_company";
  ensureTestCompany(companyId);
  const started = await startPortableWorkflowRun({
    workflowId: "job-application-manager",
    sourceTrigger: "automation_os_ui",
    idempotencyKey: "portable-remote-read-only-reconcile-complete",
    companyId,
    readOnlyStage: "candidate_supply",
    inputBundle: {
      source_snapshot_id: "snapshot-read-only-reconcile-complete",
      supply_run_id: "supply-read-only-reconcile-complete",
      bucket: "japan_targeted",
      remaining: 0,
      margin: 1,
    },
  });
  const stored = db.querySql<{ metadata_json: string }>(
    `SELECT metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`,
  )[0];
  const metadata = JSON.parse(stored.metadata_json) as Record<string, unknown>;
  db.execSql(`UPDATE runs SET metadata_json=${db.sqlValue({
    ...metadata,
    web_operation_backend: {
      requested_backend: "chrome_plugin",
      resolved_backend: "chrome_plugin",
      revision: 19,
      source: "aos_global_setting",
      fallback_allowed: false,
      browser_surface: "signed_chrome_extension_profile2",
      chrome_profile: {
        id: "profile2",
        name: "Profile 2",
        directory: "Profile 2",
        surface: "signed_chrome_extension_profile2",
      },
    },
  })} WHERE id=${db.sqlValue(started.runId)};`);
  const claim = claimPortableMacWorker({ companyId, workerId: "mac-read-only-reconcile-complete", requestedRunId: started.runId });
  assert.ok(claim);
  const backendSnapshot = {
    schema: "aos_web_operation_backend_snapshot.v1",
    requested_backend: "chrome_plugin",
    resolved_backend: "chrome_plugin",
    revision: 19,
    source: "aos_global_setting",
    fallback_allowed: false,
    chrome_profile: { id: "profile2", name: "Profile 2", directory: "Profile 2", surface: "signed_chrome_extension_profile2" },
    browser_surface: "signed_chrome_extension_profile2",
    exact_blocker: null,
  };
  const receipt = recordPortableMacWorkerReceipt({
    companyId,
    workerId: "mac-read-only-reconcile-complete",
    runId: started.runId,
    receipt: {
      status: "complete",
      exact_blocker: null,
      external_action_executed: false,
      browser_surface: "signed_chrome_extension_profile2",
      workflow_id: claim.workflow_id,
      run_id: claim.run_id,
      step_id: claim.step_id,
      cleanup_verified: true,
      readback_verified: true,
      effects_mode: "read_only",
      read_only_stage_bound: true,
      same_run_receipt: true,
      external_executor_status: "chrome_plugin_candidate_supply_completed",
      adapter_result: {
        status: "ready",
        read_only: true,
        browser_backend: "chrome_plugin",
        browser_surface: "signed_chrome_extension_profile2",
        candidate_count: 1,
        requested_count: 1,
        artifact_uri: "file:///redacted/chrome-plugin-candidate.json",
        bridge_receipt_path: "file:///redacted/chrome-plugin-bridge-receipt.json",
        bridge_instance_id: "bridge-reconcile-complete",
        web_operation_backend_snapshot: backendSnapshot,
        tab_cleanup: { ok: true, cleanup_failed: false, tabs_closed: [], tabs_kept: [] },
        cleanup_verified: true,
        readback_verified: true,
      },
    },
  });
  assert.equal(receipt.receipt.read_only_proof_verified, true);

  const step = db.querySql<{ id: string }>(`SELECT id FROM run_steps WHERE run_id=${db.sqlValue(started.runId)} LIMIT 1`)[0];
  db.execSql(`UPDATE runs SET status='queued' WHERE id=${db.sqlValue(started.runId)}; UPDATE run_steps SET status='queued' WHERE id=${db.sqlValue(step.id)};`);
  const reconciled = claimPortableMacWorker({ companyId, workerId: "mac-read-only-reconcile-next", requestedRunId: started.runId });
  assert.equal(reconciled, null);
  assert.equal(db.querySql<{ status: string }>(`SELECT status FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`)[0].status, "complete");
  assert.equal(db.querySql<{ status: string }>(`SELECT status FROM run_steps WHERE id=${db.sqlValue(step.id)} LIMIT 1`)[0].status, "completed");
});

test("remote Mac worker accepts the explicit local-worker receipt surface for local workflows", async () => {
  const companyId = "portable_remote_local_surface_regression";
  ensureTestCompany(companyId);
  const workerId = "mac-local-surface-regression";
  const started = await startPortableLocalWorkflowRun({
    workflowId: "daily-backup-safety-check",
    sourceTrigger: "automation_os_ui",
    idempotencyKey: "portable-remote-local-surface-regression",
    companyId,
    readOnlyStage: "reference_readback"
  });
  const claim = claimPortableMacWorker({ companyId, workerId, requestedRunId: started.runId });
  assert.ok(claim);

  const result = recordPortableMacWorkerReceipt({
    companyId,
    workerId,
    runId: claim.run_id,
    receipt: {
      status: "partial",
      exact_blocker: "local_backup_effect_requires_explicit_approval",
      external_action_executed: false,
      browser_surface: "local_worker",
      workflow_id: claim.workflow_id,
      run_id: claim.run_id,
      step_id: claim.step_id,
      cleanup_verified: true,
      readback_verified: true,
      effects_mode: "read_only",
      read_only_stage_bound: true,
      same_run_receipt: false,
      external_executor_status: "portable_local_worker_blocked",
      adapter_result: {
        local_workflow_receipt: true,
        execution_surface: "mac_local_worker",
        cleanup_verified: true,
        readback_verified: true,
        business_completion_verified: false
      }
    }
  });
  assert.equal(result.replayed, false);
  assert.equal(result.receipt.browser_surface, "local_worker");
  assert.equal(result.receipt.exact_blocker, "local_backup_effect_requires_explicit_approval");
  assert.equal(result.receipt.external_action_executed, false);
  const run = db.querySql<{ status: string }>(`SELECT status FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`)[0];
  assert.equal(run.status, "blocked");
});

test("backup evidence recovery fences failed attempts, replays one success, and keeps the original run bound", async () => {
  const companyId = "company_2560580981cedfd106b66245";
  ensureTestCompany(companyId);
  const backup = await import("../runs/portableLocalWorkflow.js");
  const entrypoint = await import("../runs/portableLocalWorkflowEntrypoint.js");
  const inputBundle = {
    account_ref: "github:nick353/daily-workspace-backup",
    target_key: "daily-workspace-backup:main",
    payload_hash: backup.backupBusinessPayloadHash(),
    source_snapshot_id: "source-snapshot-phase2"
  };
  const started = await entrypoint.startPortableLocalWorkflowRun({
    workflowId: "daily-backup-safety-check", sourceTrigger: "automation_os_ui",
    idempotencyKey: "backup-phase2-original", companyId, readOnlyStage: "reference_readback"
  });
  const step = db.querySql<{ id: string }>(`SELECT id FROM run_steps WHERE run_id=${db.sqlValue(started.runId)} LIMIT 1`)[0];
  const run = db.querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`)[0];
  const metadata = JSON.parse(run.metadata_json);
  const authority = {
    schema: "aos.portable_external_effect_authority.v1", authority_id: "authority-backup-phase2",
    company_id: companyId, workflow_id: "daily-backup-safety-check", run_id: started.runId, step_id: step.id,
    approval_id: "approval-backup-phase2", idempotency_key: "backup-phase2-original",
    target_digest: "target-backup-phase2", input_bundle_sha256: "bundle-backup-phase2",
    payload_hash: inputBundle.payload_hash, issued_at: "2026-09-10T13:30:26.869Z", expires_at: "2026-09-10T14:30:26.869Z",
    external_action_authorized: true
  };
  const claim = {
    run_id: started.runId, step_id: step.id, workflow_id: "daily-backup-safety-check", execution_mode: "business_effect",
    approval_id: authority.approval_id, idempotency_key: authority.idempotency_key, target_digest: authority.target_digest,
    input_bundle_sha256: authority.input_bundle_sha256, input_bundle: inputBundle, portable_effect_authority: authority,
    effect_operation_key: "backup-phase2-ledger-missing"
  };
  db.execSql(`UPDATE runs SET status='blocked', metadata_json=${db.sqlValue({ ...metadata, effect_stage: "business_execute",
    portable_input_bundle: { input: inputBundle, sha256: authority.input_bundle_sha256 },
    external_action_executed: null, remote_worker_claim: claim, remote_worker_receipt: undefined })} WHERE id=${db.sqlValue(started.runId)}`);
  const view = await readPortableRunRecovery({ companyId, runId: started.runId });
  const request = await requestPortableBackupPostEffectReconciliation({ companyId, runId: started.runId,
    expectedReadbackToken: view.readback_token, idempotencyKey: `portable-backup-post-effect-${started.runId}` });
  assert.equal(request.response.status, "queued");
  const reconciliationRun = db.querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`)[0];
  const reconciliationBinding = JSON.parse(reconciliationRun.metadata_json).portable_post_effect_reconciliation.original_claim as Record<string, unknown>;
  const first = await claimPortableBackupPostEffectReconciliationAsync({ companyId, workerId: "backup-worker", workerInstanceId: "backup-instance-1", requestedRunId: started.runId });
  assert.ok(first);
  assert.ok(first.attempt_id && first.fencing_token);
  const claimedMetadata = JSON.parse((db.querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)}`)[0]).metadata_json);
  assert.equal(claimedMetadata.portable_post_effect_reconciliation.attempt_id, first.attempt_id);
  assert.equal(claimedMetadata.portable_post_effect_reconciliation.fencing_token, first.fencing_token);
  assert.equal(claimedMetadata.portable_post_effect_reconciliation.lease_expires_at, first.lease_expires_at);
  assert.equal(await claimPortableBackupPostEffectReconciliationAsync({ companyId, workerId: "backup-worker", workerInstanceId: "backup-instance-other", requestedRunId: started.runId }), null);
  const timeout = { artifact_name: "portable-local-worker-receipt.v1.json", run_id: started.runId,
    sha256: "a".repeat(64), status: "blocked", exact_blocker: "portable_local_child_deadline_exceeded",
    external_action_executed: null, no_replay: true };
  const makeReceipt = (workerClaim: { attempt_id: string; fencing_token: string }, commit: string) => ({
    evidence_only: true, provider_replayed: false, new_effect: false, status: "complete", exact_blocker: null,
    external_action_executed: true, run_id: started.runId, step_id: step.id, workflow_id: "daily-backup-safety-check",
    original_run_id: started.runId, original_step_id: step.id, original_authority_id: authority.authority_id,
    original_authority_sha256: request.response.original_authority_sha256, original_timeout_receipt: timeout,
    original_claim: { run_id: started.runId, step_id: step.id, authority_id: authority.authority_id,
      sha256: "c".repeat(64), authority_sha256: request.response.original_authority_sha256 },
    attempt_id: workerClaim.attempt_id, fencing_token: workerClaim.fencing_token,
    reconciliation_binding: reconciliationBinding,
    evidence: { commit, remote_commit: commit, snapshot_id: "20260910T223116+0900", manifest_source_count: 6,
      readback_verified: true, remote_parity: true, git_integrity_verified: true, restore_verified: true, cleanup_verified: true,
      state_matches_snapshot_and_commit: true, original_execution_summary: {
        correlation_method: "unique_success_in_original_claim_interval", direct_child_link_verified: false,
        interval_start: "2026-09-10T13:30:27.020Z", interval_end: "2026-09-10T13:40:11.939Z", candidate_count: 1,
        sha256: "c".repeat(64), snapshot_id: "20260910T223116+0900", backup_commit: commit
      } },
    cleanup_verified: true, readback_verified: true, same_run_receipt: true, same_run_source_sync: true,
    effects_mode: "business_effect", read_only_stage_bound: false, business_completion_verified: true,
    business_proof_verified: true, browser_surface: "local_worker", connector_execution_owner: "mac_worker_explicit_connector_fallback",
    external_executor_status: "fixture-backup-evidence"
  });
  const firstClaim = first;
  const firstReceipt = makeReceipt(firstClaim, "d".repeat(40));
  const failedReceipt = { ...firstReceipt, evidence: { ...(firstReceipt.evidence as Record<string, unknown>), state_matches_snapshot_and_commit: false } };
  const expiredMetadata = JSON.parse((db.querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)}`)[0]).metadata_json);
  expiredMetadata.portable_post_effect_reconciliation.lease_expires_at = "2020-01-01T00:00:00.000Z";
  db.execSql(`UPDATE runs SET metadata_json=${db.sqlValue(expiredMetadata)} WHERE id=${db.sqlValue(started.runId)}`);
  await assert.rejects(() => recordPortableBackupPostEffectEvidenceAsync({ companyId, workerId: "backup-worker", workerInstanceId: "backup-instance-1", runId: started.runId, receipt: firstReceipt }), /portable_backup_evidence_lease_expired/u);
  expiredMetadata.portable_post_effect_reconciliation.lease_expires_at = first.lease_expires_at;
  db.execSql(`UPDATE runs SET metadata_json=${db.sqlValue(expiredMetadata)} WHERE id=${db.sqlValue(started.runId)}`);
  const failed = await recordPortableBackupPostEffectEvidenceAsync({ companyId, workerId: "backup-worker", workerInstanceId: "backup-instance-1", runId: started.runId, receipt: failedReceipt });
  assert.equal(failed.receipt.status, "blocked");
  assert.ok(failed.artifact_uri);
  const failedArtifactId = failed.artifact_uri.split("/").pop()!;
  const failedArtifact = db.querySql<{ kind: string; checksum_sha256: string; content_text: string }>(`SELECT kind, checksum_sha256, content_text FROM run_artifacts WHERE id=${db.sqlValue(failedArtifactId)} AND run_id=${db.sqlValue(started.runId)} LIMIT 1`)[0];
  assert.equal(failedArtifact.kind, "portable_backup_evidence_attempt");
  assert.equal(failedArtifact.checksum_sha256, createHash("sha256").update(failedArtifact.content_text).digest("hex"));
  assert.equal(JSON.parse(failedArtifact.content_text).attempt_id, first.attempt_id);
  assert.equal(failed.receipt.external_action_executed, null);
  assert.equal(failed.receipt.readback_verified, false);
  assert.equal(failed.receipt.cleanup_verified, false);
  assert.equal(failed.receipt.same_run_receipt, false);
  assert.equal(failed.receipt.same_run_source_sync, false);
  assert.equal(failed.receipt.business_completion_verified, false);
  assert.equal(failed.receipt.business_proof_verified, false);
  assert.deepEqual(failed.receipt.business_proofs, { backup_snapshot: false, backup_remote_push: false, backup_state: false, cleanup_receipt: false });
  assert.equal(failed.receipt.runner_receipt.status, "blocked");
  assert.equal(failed.receipt.runner_receipt.same_run_source_sync, false);
  assert.ok(failed.receipt.web_operation_lifecycle);
  assert.equal(failed.receipt.web_operation_lifecycle.status, "blocked");
  assert.equal(failed.receipt.web_operation_lifecycle.same_run_receipt, false);
  assert.ok(failed.receipt.raw_observations);
  assert.equal(failed.receipt.raw_observations.reported_readback_verified, true);
  assert.equal(db.querySql<{ status: string }>(`SELECT status FROM runs WHERE id=${db.sqlValue(started.runId)}`)[0].status, "blocked");
  const duplicateRequest = await requestPortableBackupPostEffectReconciliation({ companyId, runId: started.runId,
    expectedReadbackToken: "stale-readback-token", idempotencyKey: `portable-backup-post-effect-${started.runId}` });
  assert.equal(duplicateRequest.replayed, true);
  await assert.rejects(() => recordPortableBackupPostEffectEvidenceAsync({ companyId, workerId: "backup-worker", workerInstanceId: "backup-instance-1", runId: started.runId, receipt: firstReceipt }), /portable_backup_evidence_claim_not_active/u);
  const second = await claimPortableBackupPostEffectReconciliationAsync({ companyId, workerId: "backup-worker", workerInstanceId: "backup-instance-2", requestedRunId: started.runId });
  assert.ok(second);
  assert.notEqual(second.attempt_id, first.attempt_id);
  const secondClaimMetadata = JSON.parse((db.querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)}`)[0]).metadata_json);
  assert.equal(secondClaimMetadata.portable_post_effect_reconciliation.lease_expires_at, second.lease_expires_at);
  assert.equal(secondClaimMetadata.portable_post_effect_reconciliation.attempts.at(-1).attempt_id, second.attempt_id);
  assert.equal(db.querySql<{ state: string }>(`SELECT state FROM task_effect_ledger WHERE operation_key=${db.sqlValue(`backup-effect-${createHash("sha256").update(started.runId).digest("hex")}`)} LIMIT 1`)[0].state, "intent");
  const rollbackMetadata = JSON.parse((db.querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)}`)[0]).metadata_json);
  rollbackMetadata.portable_post_effect_reconciliation.original_claim.effect_operation_key = "backup-phase2-ledger-missing";
  db.execSql(`UPDATE runs SET metadata_json=${db.sqlValue(rollbackMetadata)} WHERE id=${db.sqlValue(started.runId)}`);
  reconciliationBinding.effect_operation_key = "backup-phase2-ledger-missing";
  const beforeLedgerFailureArtifactCount = db.querySql<{ count: number }>(`SELECT COUNT(*) AS count FROM run_artifacts WHERE run_id=${db.sqlValue(started.runId)}`)[0].count;
  await assert.rejects(
    () => recordPortableBackupPostEffectEvidenceAsync({ companyId, workerId: "backup-worker", workerInstanceId: "backup-instance-2", runId: started.runId, receipt: makeReceipt(second, "e".repeat(40)) }),
    /sql_transaction_expected_changes:1:actual:0/u
  );
  assert.equal(db.querySql<{ count: number }>(`SELECT COUNT(*) AS count FROM run_artifacts WHERE run_id=${db.sqlValue(started.runId)}`)[0].count, beforeLedgerFailureArtifactCount);
  assert.equal(db.querySql<{ status: string }>(`SELECT status FROM runs WHERE id=${db.sqlValue(started.runId)}`)[0].status, "blocked");
  const operationKey = "backup-phase2-ledger-operation";
  db.execSql(`INSERT INTO task_effect_ledger
    (operation_key, company_id, trace_id, task_id, workflow_id, target_hash, payload_hash, audience_hash, state,
     external_action_executed, ambiguous, retry_forbidden, provider_receipt_hash, source_sync_hash, reconciliation_hash,
     cleanup_hash, exact_blocker, restart_point, created_at, updated_at, closed_at)
    VALUES (${db.sqlValue(operationKey)}, ${db.sqlValue(companyId)}, 'trace-backup-phase2', ${db.sqlValue(started.runId)},
      'daily-backup-safety-check', ${db.sqlValue("a".repeat(64))}, ${db.sqlValue("b".repeat(64))}, ${db.sqlValue("c".repeat(64))},
      'executing', 0, 0, 0, NULL, NULL, NULL, NULL, NULL, 'effect_executing', ${db.sqlValue(new Date().toISOString())}, ${db.sqlValue(new Date().toISOString())}, NULL)`);
  const retryMetadata = JSON.parse((db.querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)}`)[0]).metadata_json);
  retryMetadata.portable_post_effect_reconciliation.original_claim.effect_operation_key = operationKey;
  db.execSql(`UPDATE runs SET metadata_json=${db.sqlValue(retryMetadata)} WHERE id=${db.sqlValue(started.runId)}`);
  reconciliationBinding.effect_operation_key = operationKey;
  const success = await recordPortableBackupPostEffectEvidenceAsync({ companyId, workerId: "backup-worker", workerInstanceId: "backup-instance-2", runId: started.runId, receipt: makeReceipt(second, "e".repeat(40)) });
  assert.equal(success.receipt.status, "complete");
  assert.equal(db.querySql<{ count: number }>(`SELECT COUNT(*) AS count FROM run_artifacts WHERE run_id=${db.sqlValue(started.runId)}`)[0].count, 2);
  assert.ok(db.querySql<{ id: string }>(`SELECT id FROM run_artifacts WHERE id=${db.sqlValue(failedArtifactId)} AND run_id=${db.sqlValue(started.runId)} LIMIT 1`)[0]);
  const replay = await recordPortableBackupPostEffectEvidenceAsync({ companyId, workerId: "backup-worker", workerInstanceId: "backup-instance-2", runId: started.runId, receipt: makeReceipt(second, "e".repeat(40)) });
  assert.equal(replay.replayed, true);
  assert.equal(replay.artifact_uri, success.artifact_uri);
  await assert.rejects(() => recordPortableBackupPostEffectEvidenceAsync({ companyId, workerId: "backup-worker", workerInstanceId: "backup-instance-2", runId: started.runId,
    receipt: { ...makeReceipt(second, "f".repeat(40)), evidence: { ...makeReceipt(second, "f".repeat(40)).evidence, state_matches_snapshot_and_commit: true } } }), /portable_backup_evidence_conflict/u);
  assert.equal((await readPortableRunRecovery({ companyId, runId: started.runId })).status, "complete");
});

test("NisenPrints inventory audit is claimable and stores an idempotent read-only result, not publication proof", async () => {
  const companyId = "portable_remote_inventory_fixture";
  ensureTestCompany(companyId);
  const workerId = "mac-inventory-fixture";
  const started = await startPortableLocalWorkflowRun({
    workflowId: "nisenprints-existing-product-audit", sourceTrigger: "automation_os_scheduler",
    idempotencyKey: "inventory-fixture-occurrence-1", companyId, readOnlyStage: "reference_readback"
  });
  const claim = claimPortableMacWorker({ companyId, workerId, requestedRunId: started.runId });
  assert.ok(claim);
  assert.equal(claim.workflow_id, "nisenprints-existing-product-audit");
  const receipt = { status: "complete", exact_blocker: null, external_action_executed: false,
    browser_surface: "local_worker", workflow_id: claim.workflow_id, run_id: claim.run_id, step_id: claim.step_id,
    cleanup_verified: true, readback_verified: true, effects_mode: "read_only", read_only_stage_bound: true,
    same_run_receipt: true, external_executor_status: "portable_local_worker_completed",
    adapter_result: { local_workflow_receipt: true, execution_surface: "mac_local_worker",
      local_receipt: { same_run_source_sync: true, full_publish_workflow_completed: false } } };
  const result = recordPortableMacWorkerReceipt({ companyId, workerId, runId: started.runId, receipt });
  assert.equal(result.receipt.status, "complete");
  assert.equal(result.receipt.read_only_proof_verified, true);
  assert.equal(result.receipt.business_proof_verified, false);
  assert.equal(result.receipt.external_action_executed, false);
  const repeated = recordPortableMacWorkerReceipt({ companyId, workerId, runId: started.runId, receipt });
  assert.equal(repeated.replayed, true);
  const run = db.querySql<{ status: string }>(`SELECT status FROM runs WHERE id=${db.sqlValue(started.runId)}`)[0];
  assert.equal(run.status, "complete");
});

test("Gmail worker receipt persistence keeps all 100 bounded summaries in sync and async paths", async () => {
  for (const asyncPath of [false, true]) {
    const companyId = `portable_gmail_result_${asyncPath ? "async" : "sync"}`;
    ensureTestCompany(companyId);
    const workerId = `gmail-result-${asyncPath ? "async" : "sync"}`;
    const started = await startPortableLocalWorkflowRun({ workflowId: "email-review-reply", sourceTrigger: "automation_os_ui",
      idempotencyKey: `${workerId}-read-only`, companyId, readOnlyStage: "reference_readback" });
    const claim = claimPortableMacWorker({ companyId, workerId, requestedRunId: started.runId });
    assert.ok(claim);
    const review = { provider: "gmail", operation: "summary_review", fetched_count: 100, exhausted: false,
      items: Array.from({ length: 100 }, (_, i) => ({ message_id: `mail${i}`, category: "確認", summary: `要約${i}`, reply_candidate: i < 5 ? "未送信案" : null })), exact_blocker: null };
    const result = { run_id: claim.run_id, company_id: companyId, status: "complete", exact_blocker: null, review,
      review_hash: createHash("sha256").update(JSON.stringify(review)).digest("hex"), provider_read_observed: true,
      reply_candidates_require_approval: true, messages_sent: false, provider_drafts_created: false, external_action_executed: false,
      diagnostics: { fetched_count: 100, item_count: 100, unique_id_count: 100, reply_candidate_count: 5, exhausted: false, provider_read_call_count: 2 } };
    const receipt = { status: "complete", exact_blocker: null, external_action_executed: false,
      browser_surface: "local_worker", workflow_id: claim.workflow_id, run_id: claim.run_id, step_id: claim.step_id,
      cleanup_verified: true, readback_verified: true, effects_mode: "read_only", read_only_stage_bound: true, same_run_receipt: true,
      external_executor_status: "portable_local_worker_completed", adapter_result: { local_workflow_receipt: true,
        execution_surface: "mac_local_worker", local_receipt: { review: result, ignored_deep_diagnostics: { a: { b: { c: { raw: "not copied" } } } } } } };
    const recordReceipt = asyncPath ? recordPortableMacWorkerReceiptAsync : recordPortableMacWorkerReceipt;
    const saved = await recordReceipt({ companyId, workerId, runId: claim.run_id, receipt });
    const accepted = (saved.receipt.adapter_result?.local_receipt as any).review;
    assert.equal(accepted.review.items.length, 100);
    assert.equal(accepted.review.items[99].summary, "要約99");
    assert.equal(accepted.review_hash, result.review_hash);
    assert.equal(saved.receipt.read_only_proof_verified, true);
    assert.equal(saved.receipt.business_proof_verified, false);
    assert.doesNotMatch(JSON.stringify(saved.receipt), /not copied/);
    const persisted = db.querySql<{ content_text: string }>(`SELECT content_text FROM run_artifacts WHERE run_id=${db.sqlValue(claim.run_id)} LIMIT 1`)[0];
    assert.equal(JSON.parse(persisted.content_text).adapter_result.local_receipt.review.review.items.length, 100);
    assert.equal((await recordReceipt({ companyId, workerId, runId: claim.run_id, receipt })).replayed, true);
  }
});

test("Obsidian audit project rows survive both receipt storage paths without a Vault write claim", async () => {
  for (const asyncPath of [false, true]) {
    const companyId = `portable_obsidian_rows_${asyncPath ? "async" : "sync"}`;
    ensureTestCompany(companyId);
    const workerId = `obsidian-rows-${asyncPath}`;
    const started = await startPortableLocalWorkflowRun({ workflowId: "obsidian-project-memory-audit", sourceTrigger: "automation_os_ui",
      idempotencyKey: `${workerId}-read-only`, companyId, readOnlyStage: "reference_readback" });
    const claim = claimPortableMacWorker({ companyId, workerId, requestedRunId: started.runId });
    assert.ok(claim);
    const local = { audit_ok: true, audit_summary: { projects: 10, ok: 5, attention: 5, blocked: 0 },
      audit_run_id: claim.run_id, audit_company_id: companyId, audit_generated_at: "2026-09-06T00:00:00.000Z", audit_projects_truncated: false,
      audit_projects: Array.from({ length: 10 }, (_, i) => ({ project_id: `project-${i}`, project_label: `Project ${i}`,
        status: i < 5 ? "attention" : "ok", issue_codes: i < 5 ? "state_stale" : "", finding: `Finding ${i}`,
        state_updated_at: "2026-08-01T00:00:00.000Z", latest_activity_at: "2026-09-01T00:00:00.000Z", next_action: `Read STATE ${i}` })),
      audit_only: true, write_performed: false, maintenance_performed: false, git_sync_performed: false };
    const receipt = { status: "complete", exact_blocker: null, external_action_executed: false,
      browser_surface: "local_worker", workflow_id: claim.workflow_id, run_id: claim.run_id, step_id: claim.step_id,
      cleanup_verified: true, readback_verified: true, effects_mode: "read_only", read_only_stage_bound: true, same_run_receipt: true,
      external_executor_status: "portable_local_worker_completed", adapter_result: { local_workflow_receipt: true,
        execution_surface: "mac_local_worker", local_receipt: local } };
    const recordReceipt = asyncPath ? recordPortableMacWorkerReceiptAsync : recordPortableMacWorkerReceipt;
    const saved = await recordReceipt({ companyId, workerId, runId: claim.run_id, receipt });
    assert.equal(saved.receipt.read_only_proof_verified, true);
    assert.equal(saved.receipt.business_proof_verified, false);
    assert.equal(saved.receipt.external_action_executed, false);
    const accepted = saved.receipt.adapter_result?.local_receipt as any;
    assert.equal(accepted.audit_projects.length, 10);
    assert.equal(accepted.audit_projects[9].finding, "Finding 9");
    assert.equal(accepted.audit_projects[9].next_action, "Read STATE 9");
    assert.equal(accepted.audit_company_id, companyId);
    const artifact = db.querySql<{ content_text: string }>(`SELECT content_text FROM run_artifacts WHERE run_id=${db.sqlValue(claim.run_id)} LIMIT 1`)[0];
    assert.equal(JSON.parse(artifact.content_text).adapter_result.local_receipt.audit_projects[9].project_id, "project-9");
    assert.equal((await recordReceipt({ companyId, workerId, runId: claim.run_id, receipt })).replayed, true);
  }
});

test("remote Mac worker claims a business effect only after target-bound AOS approval", async () => {
  const previousMode = process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE;
  process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = "external";
  try {
    const companyId = "portable_remote_business_company";
    ensureTestCompany(companyId);
    const started = await startPortableWorkflowRun({
      workflowId: "job-application-manager",
      sourceTrigger: "automation_os_ui",
      idempotencyKey: "portable-remote-business-regression",
      browserSurfaceRequirement: "browser_use_cli",
      companyId,
      effectStage: "one_candidate_submit",
      inputBundle: {
        account_ref: "linkedin_authenticated_job_manager",
        job_url: "https://www.linkedin.com/jobs/view/4405084150/",
        application_url: "https://www.linkedin.com/jobs/view/4405084150/",
        candidate_key: "opp-remote-business-regression",
        bucket: "japan_targeted",
        sequence: 1,
        attempt: 1,
        source_snapshot_id: "snapshot-remote-business-regression",
        supply_run_id: "supply-remote-business-regression",
        company: "Example Company",
        role: "Marketing Manager",
        payload_hash: "a".repeat(64),
      },
    });
    const workerId = "mac-remote-business-regression";
    assert.equal(claimPortableMacWorker({ companyId, workerId, requestedRunId: started.runId }), null);

    const { runWorkerOnce } = await import("../runs/workerEngine.js");
    await runWorkerOnce(started.runId);
    const approval = db.querySql<{ id: string }>(
      `SELECT id FROM approvals WHERE run_id=${db.sqlValue(started.runId)} ORDER BY created_at ASC LIMIT 1`
    )[0];
    const step = db.querySql<{ id: string }>(
      `SELECT id FROM run_steps WHERE run_id=${db.sqlValue(started.runId)} ORDER BY id ASC LIMIT 1`
    )[0];
    assert.ok(approval);
    assert.ok(step);
    db.execSql(`UPDATE approvals SET status='approved', decided_at=${db.sqlValue(new Date().toISOString())} WHERE id=${db.sqlValue(approval.id)};`);

    const claim = claimPortableMacWorker({ companyId, workerId, requestedRunId: started.runId });
    assert.ok(claim);
    assert.equal(claim.execution_mode, "business_effect");
    assert.equal(claim.business_effect_stage, "one_candidate_submit");
    assert.equal(claim.approval_id, approval.id);
    assert.equal(claim.approval_receipt?.approval_id, approval.id);
    assert.equal(claim.approval_receipt?.approval_status, "approved");
    assert.equal(claim.approval_receipt?.binding.company_id, companyId);
    assert.equal(claim.approval_receipt?.binding.idempotency_key, "portable-remote-business-regression");
    assert.equal(claim.approval_receipt?.binding.fresh_browser_use_authority_required, true);
    assert.equal(claim.approval_receipt?.binding.first_class_root_required, false);
    assert.match(String(claim.target_digest), /^[a-f0-9]{64}$/u);
    assert.ok(claim.effect_authority);
    assert.equal(claim.effect_authority?.issued_by, "automation_os_portable_controller");
    assert.equal(claim.effect_authority?.first_class_root_required, false);
    assert.equal(claim.effect_authority?.reconciliation_required, true);
    assert.equal(claim.effect_authority?.reconciliation_owner, "automation_os_portable_controller");

    const receipt = recordPortableMacWorkerReceipt({
      companyId,
      workerId,
      runId: claim.run_id,
      receipt: {
        status: "complete",
        exact_blocker: null,
        external_action_executed: true,
        browser_surface: "browser_use_cli",
        workflow_id: claim.workflow_id,
        run_id: claim.run_id,
        step_id: claim.step_id,
        cleanup_verified: true,
        readback_verified: true,
        effects_mode: "business_effect",
        business_effect_stage: claim.business_effect_stage,
        approval_receipt: claim.approval_receipt,
        target_digest: claim.target_digest,
        effect_authority_id: claim.effect_authority?.authority_id,
        effect_authority_sha256: effectAuthoritySha256(claim.effect_authority),
        same_run_receipt: true,
        external_executor_status: "submitted_confirmed",
        adapter_result: { state: "submitted_confirmed", sync_ok: true, ledger_finalized: true },
        web_operation_lifecycle: businessLifecycle(claim),
      },
    });
    assert.equal(receipt.replayed, false);
    assert.equal(receipt.receipt.external_action_executed, true);
    assert.equal(receipt.receipt.business_proof_verified, true);

    const run = db.querySql<{ status: string; metadata_json: string }>(
      `SELECT status, metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`
    )[0];
    const metadata = JSON.parse(run.metadata_json) as { external_action_executed?: boolean };
    assert.equal(run.status, "complete");
    assert.equal(metadata.external_action_executed, true);
  } finally {
    if (previousMode === undefined) delete process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE;
    else process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = previousMode;
  }
});

test("expired business authority terminalizes an explicit blocked no-effect receipt without replay", async () => {
  const previousMode = process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE;
  process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = "external";
  try {
    const companyId = "portable_remote_expired_authority_no_effect_company";
    ensureTestCompany(companyId);
    const started = await startPortableWorkflowRun({
      workflowId: "job-application-manager",
      sourceTrigger: "automation_os_ui",
      idempotencyKey: "portable-remote-expired-authority-no-effect",
      companyId,
      effectStage: "one_candidate_submit",
      inputBundle: {
        account_ref: "linkedin_authenticated_job_manager",
        job_url: "https://www.linkedin.com/jobs/view/4405084151/",
        application_url: "https://www.linkedin.com/jobs/view/4405084151/",
        candidate_key: "opp-expired-authority-no-effect",
        bucket: "japan_targeted",
        sequence: 1,
        attempt: 1,
        source_snapshot_id: "snapshot-expired-authority-no-effect",
        supply_run_id: "supply-expired-authority-no-effect",
        company: "Example Company",
        role: "Marketing Manager",
        payload_hash: "b".repeat(64),
      },
    });
    const { runWorkerOnce } = await import("../runs/workerEngine.js");
    await runWorkerOnce(started.runId);
    const approval = db.querySql<{ id: string }>(
      `SELECT id FROM approvals WHERE run_id=${db.sqlValue(started.runId)} ORDER BY created_at ASC LIMIT 1`,
    )[0];
    assert.ok(approval);
    db.execSql(`UPDATE approvals SET status='approved', decided_at=${db.sqlValue(new Date().toISOString())} WHERE id=${db.sqlValue(approval.id)};`);

    const claim = claimPortableMacWorker({
      companyId,
      workerId: "mac-expired-authority-no-effect",
      requestedRunId: started.runId,
    });
    assert.ok(claim);
    assert.ok(claim.effect_authority);
    const expiredAuthority = {
      ...claim.effect_authority,
      issued_at: "2019-01-01T00:00:00.000Z",
      expires_at: "2020-01-01T00:00:00.000Z",
      timeout_ms: 1,
    };
    const stored = db.querySql<{ metadata_json: string }>(
      `SELECT metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`,
    )[0];
    const metadata = JSON.parse(stored.metadata_json) as Record<string, unknown>;
    const storedClaim = metadata.remote_worker_claim as Record<string, unknown>;
    db.execSql(`UPDATE runs SET metadata_json=${db.sqlValue({
      ...metadata,
      remote_worker_claim: { ...storedClaim, portable_effect_authority: expiredAuthority },
    })} WHERE id=${db.sqlValue(started.runId)};`);

    const result = await recordPortableMacWorkerReceiptAsync({
      companyId,
      workerId: "mac-expired-authority-no-effect",
      runId: started.runId,
      receipt: {
        status: "blocked",
        exact_blocker: "trusted_chrome_runtime_unavailable",
        external_action_executed: false,
        browser_surface: claim.browser_surface,
        workflow_id: claim.workflow_id,
        run_id: claim.run_id,
        step_id: claim.step_id,
        cleanup_verified: true,
        readback_verified: false,
        effects_mode: "business_effect",
        business_effect_stage: claim.business_effect_stage,
        approval_receipt: claim.approval_receipt,
        target_digest: claim.target_digest,
        effect_authority_id: expiredAuthority.authority_id,
        effect_authority_sha256: effectAuthoritySha256(expiredAuthority),
        same_run_receipt: false,
        external_executor_status: "trusted_runner_bridge_unavailable",
      },
    });
    assert.equal(result.replayed, false);
    assert.equal(result.receipt.status, "blocked");
    assert.equal(result.receipt.exact_blocker, "portable_effect_authority_expired");
    assert.equal(result.receipt.external_action_executed, false);
    const state = db.querySql<{ status: string; metadata_json: string }>(
      `SELECT status, metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`,
    )[0];
    assert.equal(state.status, "blocked");
    assert.equal((JSON.parse(state.metadata_json) as Record<string, unknown>).external_action_executed, false);
  } finally {
    if (previousMode === undefined) delete process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE;
    else process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = previousMode;
  }
});

test("expired portable worker claim is blocked without replay when no receipt exists", async () => {
  const companyId = "portable_remote_expired_claim_company";
  ensureTestCompany(companyId);
  const started = await startPortableWorkflowRun({
    workflowId: "job-application-manager",
    sourceTrigger: "automation_os_scheduler",
    idempotencyKey: "portable-remote-expired-claim-regression",
    companyId,
    readOnlyStage: "candidate_supply",
    inputBundle: {
      source_snapshot_id: "snapshot-expired-claim-regression",
      supply_run_id: "supply-expired-claim-regression",
      bucket: "japan_targeted",
      remaining: 0,
      margin: 0,
    },
  });
  const firstClaim = claimPortableMacWorker({
    companyId,
    workerId: "mac-expired-claim-owner",
    requestedRunId: started.runId,
  });
  assert.ok(firstClaim);

  const stored = db.querySql<{ metadata_json: string }>(
    `SELECT metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`,
  )[0];
  const metadata = JSON.parse(stored.metadata_json) as Record<string, unknown>;
  const claim = metadata.remote_worker_claim as Record<string, unknown>;
  db.execSql(`UPDATE runs SET metadata_json=${db.sqlValue({
    ...metadata,
    remote_worker_claim: { ...claim, lease_expires_at: "2020-01-01T00:00:00.000Z" },
  })} WHERE id=${db.sqlValue(started.runId)};`);

  const nextClaim = claimPortableMacWorker({
    companyId,
    workerId: "mac-expired-claim-recovery",
  });
  assert.equal(nextClaim, null);
  const state = db.querySql<{ run_status: string; step_status: string; blocker: string; external_action_executed: number; event_count: number }>(
    `SELECT runs.status AS run_status, run_steps.status AS step_status,
       json_extract(runs.metadata_json, '$.exact_blocker') AS blocker,
       json_extract(runs.metadata_json, '$.external_action_executed') AS external_action_executed,
       (SELECT COUNT(*) FROM worker_events WHERE run_id=${db.sqlValue(started.runId)} AND event_type='portable_remote_claim_expired_reconciled') AS event_count
     FROM runs JOIN run_steps ON run_steps.run_id=runs.id
     WHERE runs.id=${db.sqlValue(started.runId)} LIMIT 1`,
  )[0];
  assert.deepEqual(state, {
    run_status: "blocked",
    step_status: "blocked",
    blocker: "portable_remote_claim_expired_without_receipt",
    external_action_executed: 0,
    event_count: 1,
  });
});

for (const mode of ["business_effect", "missing", "read_only_positive"] as const) {
  for (const asyncClaim of [false, true]) {
    test(`expired missing receipt preserves unknown or positive effects: ${mode}, async=${asyncClaim}`, async () => {
      const key = `expired-unknown-${mode}-${asyncClaim}`;
      const companyId = `company_${key}`;
      ensureTestCompany(companyId);
      const started = await startPortableLocalWorkflowRun({
        companyId, workflowId: "obsidian-project-memory-audit", sourceTrigger: "automation_os_scheduler", idempotencyKey: key
      });
      const first = claimPortableMacWorker({ companyId, workerId: "mac-expiry-test-owner", requestedRunId: started.runId });
      assert.ok(first);
      const run = db.querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)}`)[0]!;
      const metadata = JSON.parse(run.metadata_json) as Record<string, unknown>;
      const storedClaim = metadata.remote_worker_claim as Record<string, unknown>;
      const { execution_mode: _oldMode, ...rest } = storedClaim;
      const positive = mode === "read_only_positive";
      db.execSql(`UPDATE runs SET metadata_json=${db.sqlValue({
        ...metadata, external_action_executed: positive,
        remote_worker_claim: { ...rest, ...(mode !== "missing" ? { execution_mode: positive ? "read_only" : mode } : {}), lease_expires_at: "2020-01-01T00:00:00.000Z" }
      })} WHERE id=${db.sqlValue(started.runId)}`);
      const next = await (asyncClaim ? claimPortableMacWorkerAsync : claimPortableMacWorker)({ companyId, workerId: "mac-expiry-test-next" });
      assert.equal(next, null);
      const result = db.querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)}`)[0]!;
      const resultMetadata = JSON.parse(result.metadata_json) as Record<string, unknown>;
      assert.equal(result.status, "blocked");
      assert.equal(resultMetadata.external_action_executed, positive ? true : null);
      assert.equal(resultMetadata.operation_effect_state, "unknown");
      assert.equal(resultMetadata.reconciliation_required, true);
      assert.equal(resultMetadata.portable_remote_claim_reconciled, false);
      assert.equal(resultMetadata.no_replay, true);
      for (const table of ["run_steps", "worker_events"]) {
        const rows = db.querySql<{ metadata_json: string }>(`SELECT metadata_json FROM ${table} WHERE run_id=${db.sqlValue(started.runId)}${table === "worker_events" ? " AND event_type='portable_remote_claim_expired_reconciled'" : ""}`);
        assert.ok(rows.length > 0);
        for (const row of rows) {
          const evidence = JSON.parse(row.metadata_json) as Record<string, unknown>;
          assert.equal(evidence.external_action_executed, positive ? true : null);
          assert.equal(evidence.reconciliation_required, true);
        }
      }
      assert.equal(await claimPortableMacWorkerAsync({ companyId, workerId: "mac-expiry-test-next" }), null);
    });
  }
}

test("expired registered root is terminally blocked instead of remaining queued forever", async () => {
  const companyId = "portable_remote_expired_root_company";
  ensureTestCompany(companyId);
  const started = await startPortableWorkflowRun({
    workflowId: "daily-ai-research-publish-run",
    sourceTrigger: "automation_os_ui",
    idempotencyKey: "portable-remote-expired-root-regression",
    companyId,
    readOnlyStage: "reference_readback",
  });
  const stored = db.querySql<{ metadata_json: string }>(
    `SELECT metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`,
  )[0];
  const metadata = JSON.parse(stored.metadata_json) as Record<string, unknown>;
  const { createRegisteredRootAdmissionV1 } = await import("../runs/registeredRootAdmission.js");
  const expiredRoot = createRegisteredRootAdmissionV1({
    registeredAutomationId: "daily-ai-research-publish-run",
    workflowId: "daily-ai-research-publish-run",
    runId: started.runId,
    sourceTrigger: "automation_os_ui",
    definitionFingerprint: String((metadata.registered_root_admission as Record<string, unknown>).definition_fingerprint),
    now: "2020-01-01T00:00:00.000Z",
    ttlMs: 60_000,
  });
  db.execSql(`UPDATE runs SET metadata_json=${db.sqlValue({
    ...metadata,
    registered_root_admission: expiredRoot,
  })} WHERE id=${db.sqlValue(started.runId)};`);

  assert.equal(claimPortableMacWorker({
    companyId,
    workerId: "mac-expired-root-regression",
    requestedRunId: started.runId,
  }), null);
  const state = db.querySql<{ run_status: string; step_status: string; blocker: string; external_action_executed: number; event_count: number }>(
    `SELECT runs.status AS run_status, run_steps.status AS step_status,
       json_extract(runs.metadata_json, '$.exact_blocker') AS blocker,
       json_extract(runs.metadata_json, '$.external_action_executed') AS external_action_executed,
       (SELECT COUNT(*) FROM worker_events WHERE run_id=${db.sqlValue(started.runId)} AND event_type='portable_remote_registered_root_reconciled') AS event_count
     FROM runs JOIN run_steps ON run_steps.run_id=runs.id
     WHERE runs.id=${db.sqlValue(started.runId)} LIMIT 1`,
  )[0];
  assert.deepEqual(state, {
    run_status: "blocked",
    step_status: "blocked",
    blocker: "registered_root_admission_invalid:expired",
    external_action_executed: 0,
    event_count: 1,
  });
});

test("candidate-supply claim waits for the persisted input bundle boundary", async () => {
    const companyId = "portable_remote_bundle_race_company";
    ensureTestCompany(companyId);
  const started = await startPortableWorkflowRun({
    workflowId: "job-application-manager",
    sourceTrigger: "automation_os_scheduler",
    idempotencyKey: "portable-remote-bundle-race-regression",
    browserSurfaceRequirement: "browser_use_cli",
    companyId,
    readOnlyStage: "candidate_supply",
  });

  assert.equal(claimPortableMacWorker({
    companyId,
    workerId: "mac-bundle-race-regression",
    requestedRunId: started.runId,
  }), null);
  const state = db.querySql<{ status: string; metadata_json: string }>(
    `SELECT status, metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`,
  )[0];
  const metadata = JSON.parse(state.metadata_json) as Record<string, unknown>;
  assert.equal(state.status, "queued");
  assert.notEqual(metadata.external_action_executed, true);
  assert.equal(metadata.exact_blocker, undefined);
});

test("portable business claim fails closed when the AOS authority is absent, without a Codex App root", async () => {
  const previousMode = process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE;
  process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = "external";
  try {
    const companyId = "portable_remote_authority_missing_company";
    ensureTestCompany(companyId);
    const started = await startPortableWorkflowRun({
      workflowId: "job-application-manager",
      sourceTrigger: "automation_os_scheduler",
      idempotencyKey: "portable-remote-authority-missing-regression",
      companyId,
      effectStage: "one_candidate_submit",
      inputBundle: {
        account_ref: "linkedin_authenticated_job_manager",
        job_url: "https://www.linkedin.com/jobs/view/4405084151/",
        application_url: "https://www.linkedin.com/jobs/view/4405084151/",
        candidate_key: "opp-remote-authority-missing-regression",
        bucket: "japan_targeted",
        sequence: 1,
        attempt: 1,
        source_snapshot_id: "snapshot-remote-authority-missing-regression",
        supply_run_id: "supply-remote-authority-missing-regression",
        payload_hash: "b".repeat(64),
      },
    });
    const { runWorkerOnce } = await import("../runs/workerEngine.js");
    await runWorkerOnce(started.runId);
    const approval = db.querySql<{ id: string }>(
      `SELECT id FROM approvals WHERE run_id=${db.sqlValue(started.runId)} ORDER BY created_at ASC LIMIT 1`,
    )[0];
    assert.ok(approval);
    db.execSql(`UPDATE approvals SET status='approved', decided_at=${db.sqlValue(new Date().toISOString())} WHERE id=${db.sqlValue(approval.id)};`);

    const workerId = "mac-remote-authority-missing-regression";
    const claim = claimPortableMacWorker({ companyId, workerId, requestedRunId: started.runId });
    assert.ok(claim);
    assert.ok(claim.effect_authority);
    const stored = db.querySql<{ metadata_json: string }>(
      `SELECT metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`,
    )[0];
    const metadata = JSON.parse(stored.metadata_json) as Record<string, unknown>;
    assert.equal(metadata.first_class_root, undefined);
    assert.equal(metadata.codex_app_server_root, undefined);
    const storedClaim = metadata.remote_worker_claim as Record<string, unknown>;
    delete storedClaim.portable_effect_authority;
    db.execSql(`UPDATE runs SET metadata_json=${db.sqlValue(metadata)}, updated_at=${db.sqlValue(new Date().toISOString())} WHERE id=${db.sqlValue(started.runId)};`);

    assert.equal(claimPortableMacWorker({ companyId, workerId, requestedRunId: started.runId }), null);
  } finally {
    if (previousMode === undefined) delete process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE;
    else process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = previousMode;
  }
});

test("portable business claim fails closed when an approved candidate URL drifts", async () => {
  const previousMode = process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE;
  process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = "external";
  try {
    const companyId = "portable_remote_target_drift_company";
    ensureTestCompany(companyId);
    const started = await startPortableWorkflowRun({
      workflowId: "job-application-manager",
      sourceTrigger: "automation_os_ui",
      idempotencyKey: "portable-target-drift-regression",
      companyId,
      effectStage: "one_candidate_submit",
      inputBundle: {
        account_ref: "linkedin_authenticated_job_manager",
        job_url: "https://www.linkedin.com/jobs/view/4405084152/",
        application_url: "https://www.linkedin.com/jobs/view/4405084152/",
        candidate_key: "opp-target-drift",
        bucket: "japan_targeted",
        sequence: 1,
        attempt: 1,
        source_snapshot_id: "snapshot-target-drift",
        supply_run_id: "supply-target-drift",
        payload_hash: "c".repeat(64)
      }
    });
    const { runWorkerOnce } = await import("../runs/workerEngine.js");
    await runWorkerOnce(started.runId);
    const approval = db.querySql<{ id: string }>(`SELECT id FROM approvals WHERE run_id=${db.sqlValue(started.runId)} ORDER BY created_at ASC LIMIT 1`)[0];
    assert.ok(approval);
    db.execSql(`UPDATE approvals SET status='approved', decided_at=${db.sqlValue(new Date().toISOString())} WHERE id=${db.sqlValue(approval.id)};`);
    const row = db.querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`)[0];
    const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    const bundle = metadata.portable_input_bundle as Record<string, unknown>;
    const input = bundle.input as Record<string, unknown>;
    db.execSql(`UPDATE runs SET metadata_json=${db.sqlValue({
      ...metadata,
      portable_input_bundle: { ...bundle, input: { ...input, application_url: "https://www.linkedin.com/jobs/view/4405999999/" } }
    })} WHERE id=${db.sqlValue(started.runId)};`);
    assert.equal(claimPortableMacWorker({ companyId, workerId: "mac-target-drift-regression", requestedRunId: started.runId }), null);
  } finally {
    if (previousMode === undefined) delete process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE;
    else process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = previousMode;
  }
});

test("Daily AI and NisenPrints reject generic receipts without workflow business proofs", async () => {
  const previousMode = process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE;
  process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = "external";
  try {
    const cases = [
      {
        workflowId: "daily-ai-research-publish-run",
        stage: "publish",
        companyId: "portable_daily_business_proof_company",
        idempotencyKey: "portable-daily-business-proof-regression",
        bundle: {
          account_ref: "daily-ai-account",
          target_key: "daily-ai-target",
          content_key: "daily-ai-content",
          payload_hash: "a".repeat(64),
          source_snapshot_id: "daily-ai-snapshot",
        },
      },
      {
        workflowId: "nisenprints-daily-product-canva-printify-etsy-pinterest",
        stage: "business_execute",
        companyId: "portable_nisen_business_proof_company",
        idempotencyKey: "portable-nisen-business-proof-regression",
        bundle: {
          account_ref: "nisenprints-account",
          target_key: "nisenprints-target",
          product_key: "nisenprints-product",
          asset_manifest_id: "nisenprints-assets",
          payload_hash: "b".repeat(64),
          source_snapshot_id: "nisenprints-snapshot",
        },
      },
    ] as const;
    const { runWorkerOnce } = await import("../runs/workerEngine.js");
    for (const item of cases) {
      const started = await startPortableWorkflowRun({
        workflowId: item.workflowId,
        sourceTrigger: "automation_os_scheduler",
        idempotencyKey: item.idempotencyKey,
        browserSurfaceRequirement: "browser_use_cli",
        companyId: item.companyId,
        effectStage: item.stage,
        inputBundle: item.bundle,
      });
      ensureTestCompany(item.companyId);
      await runWorkerOnce(started.runId);
      const approval = db.querySql<{ id: string }>(
        `SELECT id FROM approvals WHERE run_id=${db.sqlValue(started.runId)} ORDER BY created_at ASC LIMIT 1`,
      )[0];
      assert.ok(approval);
      db.execSql(`UPDATE approvals SET status='approved', decided_at=${db.sqlValue(new Date().toISOString())} WHERE id=${db.sqlValue(approval.id)};`);
      const workerId = `${item.workflowId}-proof-regression-worker`;
      const claim = claimPortableMacWorker({ companyId: item.companyId, workerId, requestedRunId: started.runId });
      assert.ok(claim);
      const receipt = recordPortableMacWorkerReceipt({
        companyId: item.companyId,
        workerId,
        runId: claim.run_id,
        receipt: {
          status: "complete",
          exact_blocker: null,
          external_action_executed: true,
          browser_surface: "browser_use_cli",
          workflow_id: claim.workflow_id,
          run_id: claim.run_id,
          step_id: claim.step_id,
          cleanup_verified: true,
          readback_verified: true,
          effects_mode: "business_effect",
          business_effect_stage: claim.business_effect_stage,
          approval_receipt: claim.approval_receipt,
          target_digest: claim.target_digest,
          effect_authority_id: claim.effect_authority?.authority_id,
          effect_authority_sha256: effectAuthoritySha256(claim.effect_authority),
          same_run_receipt: true,
          external_executor_status: "generic_receipt_only",
          runner_receipt: { schema: "generic_runner_receipt.v1" },
          web_operation_lifecycle: businessLifecycle(claim),
        },
      });
      assert.equal(receipt.receipt.business_proof_verified, false);
      assert.equal(receipt.receipt.status, "blocked");
      assert.equal(receipt.receipt.exact_blocker, "portable_remote_business_receipt_reconciliation_required");
    }
  } finally {
    if (previousMode === undefined) delete process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE;
    else process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = previousMode;
  }
});

test("Daily AI business effect requires every plan proof and same-run source sync", async () => {
  const previousMode = process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE;
  process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = "external";
  try {
    const companyId = "portable_daily_business_proof_complete_company";
    ensureTestCompany(companyId);
    const started = await startPortableWorkflowRun({
      workflowId: "daily-ai-research-publish-run",
      sourceTrigger: "automation_os_scheduler",
      idempotencyKey: "portable-daily-business-proof-complete-regression",
      browserSurfaceRequirement: "browser_use_cli",
      companyId,
      effectStage: "publish",
      inputBundle: {
        account_ref: "daily-ai-account",
        target_key: "daily-ai-target-complete",
        content_key: "daily-ai-content-complete",
        payload_hash: "c".repeat(64),
        source_snapshot_id: "daily-ai-snapshot-complete",
      },
    });
    const { runWorkerOnce } = await import("../runs/workerEngine.js");
    await runWorkerOnce(started.runId);
    const approval = db.querySql<{ id: string }>(
      `SELECT id FROM approvals WHERE run_id=${db.sqlValue(started.runId)} ORDER BY created_at ASC LIMIT 1`,
    )[0];
    assert.ok(approval);
    db.execSql(`UPDATE approvals SET status='approved', decided_at=${db.sqlValue(new Date().toISOString())} WHERE id=${db.sqlValue(approval.id)};`);
    const workerId = "daily-ai-business-proof-complete-worker";
    const claim = claimPortableMacWorker({ companyId, workerId, requestedRunId: started.runId });
    assert.ok(claim);
    const receipt = recordPortableMacWorkerReceipt({
      companyId,
      workerId,
      runId: claim.run_id,
      receipt: {
        status: "complete",
        exact_blocker: null,
        external_action_executed: true,
        browser_surface: "browser_use_cli",
        workflow_id: claim.workflow_id,
        run_id: claim.run_id,
        step_id: claim.step_id,
        cleanup_verified: true,
        readback_verified: true,
        effects_mode: "business_effect",
        business_effect_stage: claim.business_effect_stage,
        approval_receipt: claim.approval_receipt,
        target_digest: claim.target_digest,
        effect_authority_id: claim.effect_authority?.authority_id,
        effect_authority_sha256: effectAuthoritySha256(claim.effect_authority),
        same_run_receipt: true,
        external_executor_status: "daily_ai_business_proof_complete",
        runner_receipt: {
          schema: "daily_ai_business_runner_receipt.v1",
          same_run_source_sync: true,
          business_proofs: {
            publish_url_or_exact_blocker: true,
            feed_study_or_exact_blocker: true,
            engagement_or_no_candidate_proof: true,
            queue_sync: true,
            cleanup_receipt: true,
          },
        },
        web_operation_lifecycle: businessLifecycle(claim),
      },
    });
    assert.equal(receipt.receipt.status, "complete");
    assert.equal(receipt.receipt.external_action_executed, true);
    assert.equal(receipt.receipt.business_proof_verified, true);
    assert.equal(receipt.receipt.same_run_source_sync, true);
  } finally {
    if (previousMode === undefined) delete process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE;
    else process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = previousMode;
  }
});

test("Daily AI source-sync proof binds the inner receipt to the fixed mirror", () => {
  const binding = {
    companyId: dailyAi.DAILY_AI_RESEARCH_SYNC_COMPANY,
    runId: "run_daily_source_fixture",
    stepId: "step_daily_source_fixture",
    idempotencyKey: "daily-source-fixture-key",
    targetDigest: "a".repeat(64),
    inputBundleSha256: "b".repeat(64),
    sourceSnapshotId: "c".repeat(64),
    payloadHash: dailyAi.dailyAiResearchSyncPayloadHash(),
  };
  const runnerReceipt: Record<string, any> = {
    schema: "aos.daily_ai_research_source_sync_receipt.v1",
    company_id: binding.companyId,
    workflow_id: dailyAi.DAILY_AI_RESEARCH_SYNC_WORKFLOW,
    run_id: binding.runId,
    step_id: binding.stepId,
    idempotency_key: binding.idempotencyKey,
    target_digest: binding.targetDigest,
    input_bundle_sha256: binding.inputBundleSha256,
    source_snapshot_id: binding.sourceSnapshotId,
    payload_hash: binding.payloadHash,
    payload_sha256: "d".repeat(64),
    status: "complete",
    exact_blocker: null,
    external_action_executed: true,
    same_run_receipt: true,
    same_run_source_sync: true,
    readback_verified: true,
    cleanup_verified: true,
    full_publish_completed: false,
    generation_performed: false,
    research: { metrics: { published: 0, sheets_synced: 0, auto_promoted: 0 } },
    mirror: {
      spreadsheet_id: dailyAi.DAILY_AI_RESEARCH_SYNC_SHEET,
      sheet_id: 1541274581,
      mirror_column_count: 39,
      all_local_ids_and_columns_match: true,
      manual_views_match: true,
    },
    business_proofs: {
      research_queue: true,
      existing_sheet_mirror: true,
      all_mirror_columns: true,
      cleanup_receipt: true,
    },
  };
  const input = {
    same_run_receipt: true,
    same_run_source_sync: true,
    cleanup_verified: true,
    readback_verified: true,
    external_action_executed: true,
    runner_receipt: runnerReceipt,
  };
  assert.equal(
    businessProofSatisfied(dailyAi.DAILY_AI_RESEARCH_SYNC_WORKFLOW, input, { remote_verified: true }, binding),
    true,
  );
});

test("Daily AI source-sync proof rejects inner binding, mirror, schema, and publication drift", () => {
  const baseBinding = {
    companyId: dailyAi.DAILY_AI_RESEARCH_SYNC_COMPANY,
    runId: "run_daily_source_reject_fixture",
    stepId: "step_daily_source_reject_fixture",
    idempotencyKey: "daily-source-reject-key",
    targetDigest: "a".repeat(64),
    inputBundleSha256: "b".repeat(64),
    sourceSnapshotId: "c".repeat(64),
    payloadHash: dailyAi.dailyAiResearchSyncPayloadHash(),
  };
  const makeReceipt = (): Record<string, any> => ({
    company_id: baseBinding.companyId,
    workflow_id: dailyAi.DAILY_AI_RESEARCH_SYNC_WORKFLOW,
    run_id: baseBinding.runId,
    step_id: baseBinding.stepId,
    idempotency_key: baseBinding.idempotencyKey,
    target_digest: baseBinding.targetDigest,
    input_bundle_sha256: baseBinding.inputBundleSha256,
    source_snapshot_id: baseBinding.sourceSnapshotId,
    payload_hash: baseBinding.payloadHash,
    status: "complete",
    exact_blocker: null,
    external_action_executed: true,
    same_run_receipt: true,
    same_run_source_sync: true,
    readback_verified: true,
    cleanup_verified: true,
    full_publish_completed: false,
    generation_performed: false,
    research: { metrics: { published: 0, sheets_synced: 0, auto_promoted: 0 } },
    mirror: {
      spreadsheet_id: dailyAi.DAILY_AI_RESEARCH_SYNC_SHEET,
      sheet_id: 1541274581,
      mirror_column_count: 39,
      all_local_ids_and_columns_match: true,
      manual_views_match: true,
    },
    business_proofs: { research_queue: true, existing_sheet_mirror: true, all_mirror_columns: true, cleanup_receipt: true },
  });
  const mutations: Array<[string, (receipt: Record<string, any>) => void]> = [
    ["company", (receipt) => { receipt.company_id = "foreign"; }],
    ["workflow", (receipt) => { receipt.workflow_id = "foreign"; }],
    ["run", (receipt) => { receipt.run_id = "foreign"; }],
    ["step", (receipt) => { receipt.step_id = "foreign"; }],
    ["idempotency", (receipt) => { receipt.idempotency_key = "foreign"; }],
    ["target", (receipt) => { receipt.target_digest = "f".repeat(64); }],
    ["source", (receipt) => { receipt.source_snapshot_id = "f".repeat(64); }],
    ["payload", (receipt) => { receipt.input_bundle_sha256 = "f".repeat(64); }],
    ["manual-view", (receipt) => { receipt.mirror.manual_views_match = false; }],
    ["columns", (receipt) => { receipt.mirror.mirror_column_count = 9; }],
    ["sheet", (receipt) => { receipt.mirror.spreadsheet_id = "foreign"; }],
    ["gid", (receipt) => { receipt.mirror.sheet_id = 1; }],
    ["publication", (receipt) => { receipt.full_publish_completed = true; }],
  ];
  for (const [label, mutate] of mutations) {
    const runnerReceipt = makeReceipt();
    mutate(runnerReceipt);
    assert.equal(
      businessProofSatisfied(
        dailyAi.DAILY_AI_RESEARCH_SYNC_WORKFLOW,
        { same_run_receipt: true, same_run_source_sync: true, cleanup_verified: true, readback_verified: true, external_action_executed: true, runner_receipt: runnerReceipt },
        { remote_verified: true },
        baseBinding,
      ),
      false,
      label,
    );
  }
});

test("approved portable business runs recover from blocked state into the Mac worker queue", async () => {
  const previousMode = process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE;
  process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = "external";
  try {
  const companyId = "portable_remote_approval_recovery_company";
  ensureTestCompany(companyId);
    const started = await startPortableWorkflowRun({
      workflowId: "job-application-manager",
      sourceTrigger: "automation_os_scheduler",
      idempotencyKey: "portable-remote-approval-recovery-regression",
      companyId,
      effectStage: "one_candidate_submit",
      inputBundle: {
        account_ref: "linkedin_authenticated_job_manager",
        job_url: "https://www.linkedin.com/jobs/view/4405084151/",
        application_url: "https://www.linkedin.com/jobs/view/4405084151/",
        candidate_key: "opp-remote-approval-recovery",
        bucket: "japan_targeted",
        sequence: 1,
        attempt: 1,
        source_snapshot_id: "snapshot-remote-approval-recovery",
        supply_run_id: "supply-remote-approval-recovery",
        company: "Example Company",
        role: "Marketing Manager",
        payload_hash: "d".repeat(64),
      },
    });
    const approval = db.querySql<{ id: string }>(
      `SELECT id FROM approvals WHERE run_id=${db.sqlValue(started.runId)} ORDER BY created_at ASC LIMIT 1`
    )[0];
    const step = db.querySql<{ id: string; lane_id: string | null }>(
      `SELECT id, lane_id FROM run_steps WHERE run_id=${db.sqlValue(started.runId)} ORDER BY id ASC LIMIT 1`
    )[0];
    assert.ok(approval);
    assert.ok(step);

    // Reproduce the observed production state: approval is later decided but
    // the run/step were left blocked and therefore invisible to claim SQL.
    db.execSql(`
      UPDATE runs SET status='blocked', metadata_json=${db.sqlValue({
        ...JSON.parse(db.querySql<{ metadata_json: string }>(
          `SELECT metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`
        )[0].metadata_json),
        exact_blocker: "portable_external_approval_required",
        external_action_executed: false
      })} WHERE id=${db.sqlValue(started.runId)};
      UPDATE run_steps SET status='blocked' WHERE id=${db.sqlValue(step.id)};
      UPDATE lanes SET status='blocked', health='approval_required' WHERE id=${db.sqlValue(step.lane_id ?? "")};
      UPDATE approvals SET status='approved', decided_at=${db.sqlValue(new Date().toISOString())} WHERE id=${db.sqlValue(approval.id)};
    `);

    const recovered = requeuePortableMacWorkerAfterApproval(started.runId);
    assert.deepEqual(recovered, {
      requeued: true,
      reason: "approval_decided_requeued",
      approval_id: approval.id
    });

    const state = db.querySql<{ run_status: string; step_status: string; lane_status: string }>(
      `SELECT runs.status AS run_status, run_steps.status AS step_status, lanes.status AS lane_status
       FROM runs JOIN run_steps ON run_steps.run_id=runs.id JOIN lanes ON lanes.id=run_steps.lane_id
       WHERE runs.id=${db.sqlValue(started.runId)} AND run_steps.id=${db.sqlValue(step.id)} LIMIT 1`
    )[0];
    assert.deepEqual(state, { run_status: "queued", step_status: "queued", lane_status: "active" });

    const claim = claimPortableMacWorker({ companyId, workerId: "mac-approval-recovery", requestedRunId: started.runId });
    assert.ok(claim);
    assert.equal(claim.approval_id, approval.id);
    assert.equal(claim.external_action_executed, false);
  } finally {
    if (previousMode === undefined) delete process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE;
    else process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = previousMode;
  }
});

test("async approval recovery persists the target-bound receipt before Mac worker pickup", async () => {
  const previousMode = process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE;
  process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = "external";
  try {
    const companyId = "portable_remote_async_approval_recovery_company";
    ensureTestCompany(companyId);
    const started = await startPortableWorkflowRun({
      workflowId: "job-application-manager",
      sourceTrigger: "automation_os_scheduler",
      idempotencyKey: "portable-remote-async-approval-recovery-regression",
      companyId,
      effectStage: "one_candidate_submit",
      inputBundle: {
        account_ref: "linkedin_authenticated_job_manager",
        job_url: "https://www.linkedin.com/jobs/view/4405084152/",
        application_url: "https://www.linkedin.com/jobs/view/4405084152/",
        candidate_key: "opp-remote-async-approval-recovery",
        bucket: "japan_targeted",
        sequence: 1,
        attempt: 1,
        source_snapshot_id: "snapshot-remote-async-approval-recovery",
        supply_run_id: "supply-remote-async-approval-recovery",
        company: "Example Company",
        role: "Marketing Manager",
        payload_hash: "e".repeat(64),
      },
    });
    const approval = db.querySql<{ id: string }>(
      `SELECT id FROM approvals WHERE run_id=${db.sqlValue(started.runId)} ORDER BY created_at ASC LIMIT 1`
    )[0];
    const step = db.querySql<{ id: string }>(
      `SELECT id FROM run_steps WHERE run_id=${db.sqlValue(started.runId)} ORDER BY id ASC LIMIT 1`
    )[0];
    assert.ok(approval);
    assert.ok(step);
    // The user has already approved the exact run, but the worker was offline
    // until the approval lease expired. Recovery may renew only this
    // same-run, lock-bound approval; it must not create a new target/run.
    db.execSql(`UPDATE approvals SET status='approved', decided_at=${db.sqlValue(new Date().toISOString())}, step_id=NULL, action_kind=NULL, target_account_ref_id=NULL, payload_hash=NULL, policy_version=NULL, expires_at='2020-01-01T00:00:00.000Z' WHERE id=${db.sqlValue(approval.id)};`);

    const recovered = await requeuePortableMacWorkerAfterApprovalAsync(started.runId);
    assert.deepEqual(recovered, {
      requeued: true,
      reason: "approval_decided_requeued",
      approval_id: approval.id
    });

    const state = db.querySql<{ run_status: string; step_status: string; metadata_json: string }>(
      `SELECT runs.status AS run_status, run_steps.status AS step_status, runs.metadata_json
       FROM runs JOIN run_steps ON run_steps.run_id=runs.id
       WHERE runs.id=${db.sqlValue(started.runId)} ORDER BY run_steps.id ASC LIMIT 1`
    )[0];
    assert.equal(state.run_status, "queued");
    assert.equal(state.step_status, "queued");
    const metadata = JSON.parse(state.metadata_json) as Record<string, unknown>;
    assert.equal(metadata.approval_status, "approved");
    assert.equal((metadata.portable_target_bound_approval_receipt as Record<string, unknown>).approval_status, "approved");
    assert.equal((metadata.portable_target_bound_approval_receipt as Record<string, unknown>).external_action_authorized, false);
    const approvalBinding = db.querySql<{ step_id: string; action_kind: string; policy_version: string; expires_at: string }>(
      `SELECT step_id, action_kind, policy_version, expires_at FROM approvals WHERE id=${db.sqlValue(approval.id)} LIMIT 1`
    )[0];
    assert.equal(approvalBinding.step_id, step.id);
    assert.equal(approvalBinding.action_kind, "one_candidate_submit");
    assert.equal(approvalBinding.policy_version, "automation_os_portable_external_approval_binding.v1");
    assert.ok(Date.parse(approvalBinding.expires_at) > Date.now());

    const claim = claimPortableMacWorker({ companyId, workerId: "mac-async-approval-recovery", requestedRunId: started.runId });
    assert.ok(claim);
    assert.equal(claim.approval_id, approval.id);
    assert.equal(claim.external_action_executed, false);
  } finally {
    if (previousMode === undefined) delete process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE;
    else process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = previousMode;
  }
});

test("stale portable preparation is terminalized without creating an approval or replaying an effect", async () => {
  const previousMode = process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE;
  process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = "external";
  try {
    const companyId = "portable_remote_stale_preparation_company";
    ensureTestCompany(companyId);
    const started = await startPortableLocalWorkflowRun({
      workflowId: "obsidian-project-memory-audit",
      sourceTrigger: "automation_os_scheduler",
      idempotencyKey: "portable-remote-stale-preparation-regression",
      companyId,
      readOnlyStage: "reference_readback",
    });
    const run = db.querySql<{ metadata_json: string }>(
      `SELECT metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`
    )[0];
    const step = db.querySql<{ id: string; lane_id: string | null }>(
      `SELECT id, lane_id FROM run_steps WHERE run_id=${db.sqlValue(started.runId)} ORDER BY id ASC LIMIT 1`
    )[0];
    assert.ok(run);
    assert.ok(step);

    const metadata = JSON.parse(run.metadata_json) as Record<string, unknown>;
    db.execSql(`
      DELETE FROM approvals WHERE run_id=${db.sqlValue(started.runId)};
      UPDATE runs SET status='preparing', created_at='2020-01-01T00:00:00.000Z', metadata_json=${db.sqlValue({
        ...metadata,
        external_action_executed: false,
        effect_stage: 'business_execute',
        portable_workflow_invocation: {
          ...(metadata.portable_workflow_invocation as Record<string, unknown>),
          effect_stage: 'business_execute',
        },
        portable_worker: {
          ...(metadata.portable_worker as Record<string, unknown>),
          mode: 'business_effect',
          effect_stage: 'business_execute',
        },
      })} WHERE id=${db.sqlValue(started.runId)};
      UPDATE run_steps SET status='preparing', completed_at=NULL WHERE id=${db.sqlValue(step.id)};
      UPDATE lanes SET status='blocked', health='preparing' WHERE id=${db.sqlValue(step.lane_id ?? "")};
    `);

    const result = await reconcileStalePortablePreparingRunsAsync({ companyId });
    assert.deepEqual(result, { reconciled: 1, run_ids: [started.runId] });
    const state = db.querySql<{ run_status: string; step_status: string; lane_status: string; metadata_json: string }>(
      `SELECT runs.status AS run_status, run_steps.status AS step_status, lanes.status AS lane_status, runs.metadata_json
       FROM runs JOIN run_steps ON run_steps.run_id=runs.id JOIN lanes ON lanes.id=run_steps.lane_id
       WHERE runs.id=${db.sqlValue(started.runId)} AND run_steps.id=${db.sqlValue(step.id)} LIMIT 1`
    )[0];
    assert.deepEqual({ run_status: state.run_status, step_status: state.step_status, lane_status: state.lane_status }, {
      run_status: "blocked",
      step_status: "blocked",
      lane_status: "blocked",
    });
    const finalMetadata = JSON.parse(state.metadata_json) as Record<string, unknown>;
    assert.equal(finalMetadata.exact_blocker, "portable_local_business_preparation_incomplete");
    assert.equal(finalMetadata.external_action_executed, false);
    assert.equal(finalMetadata.portable_preparation_no_effect_verified, true);
    assert.equal(db.querySql<{ count: number }>(
      `SELECT count(*) AS count FROM approvals WHERE run_id=${db.sqlValue(started.runId)}`
    )[0].count, 0);
  } finally {
    if (previousMode === undefined) delete process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE;
    else process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = previousMode;
  }
});

test("existing no-effect receipt is reconciled and cannot block a newer Mac worker candidate", async () => {
  const companyId = "portable_remote_receipt_reconciliation_company";
  ensureTestCompany(companyId);
  const workerId = "mac-receipt-reconciliation-regression";
  const older = await startPortableWorkflowRun({
    workflowId: "job-application-manager",
    sourceTrigger: "automation_os_scheduler",
    idempotencyKey: "portable-remote-receipt-reconciliation-older",
    companyId,
    readOnlyStage: "candidate_supply",
    inputBundle: {
      source_snapshot_id: "snapshot-receipt-reconciliation-older",
      supply_run_id: "supply-receipt-reconciliation-older",
      bucket: "japan_targeted",
      remaining: 0,
      margin: 0,
    },
  });
  const oldClaim = claimPortableMacWorker({ companyId, workerId, requestedRunId: older.runId });
  assert.ok(oldClaim);
  const oldRun = db.querySql<{ metadata_json: string }>(
    `SELECT metadata_json FROM runs WHERE id=${db.sqlValue(older.runId)} LIMIT 1`
  )[0];
  const oldMetadata = JSON.parse(oldRun.metadata_json) as Record<string, unknown>;
  db.execSql(`UPDATE runs SET status='running', metadata_json=${db.sqlValue({
    ...oldMetadata,
    remote_worker_receipt: {
      status: "blocked",
      exact_blocker: "portable_external_worker_timeout",
      external_action_executed: false,
      artifact_uri: "file:///redacted/portable-receipt.json"
    }
  })} WHERE id=${db.sqlValue(older.runId)};`);

  const newer = await startPortableWorkflowRun({
    workflowId: "job-application-manager",
    sourceTrigger: "automation_os_scheduler",
    idempotencyKey: "portable-remote-receipt-reconciliation-newer",
    companyId,
    readOnlyStage: "candidate_supply",
    inputBundle: {
      source_snapshot_id: "snapshot-receipt-reconciliation-newer",
      supply_run_id: "supply-receipt-reconciliation-newer",
      bucket: "japan_targeted",
      remaining: 0,
      margin: 0,
    },
  });

  const nextClaim = claimPortableMacWorker({ companyId, workerId });
  assert.ok(nextClaim);
  assert.equal(nextClaim.run_id, newer.runId);
  const oldState = db.querySql<{ run_status: string; step_status: string; blocker: string; event_count: number }>(
    `SELECT runs.status AS run_status, run_steps.status AS step_status, json_extract(runs.metadata_json, '$.exact_blocker') AS blocker,
       (SELECT COUNT(*) FROM worker_events WHERE run_id=${db.sqlValue(older.runId)} AND event_type='portable_remote_receipt_reconciled') AS event_count
     FROM runs JOIN run_steps ON run_steps.run_id=runs.id WHERE runs.id=${db.sqlValue(older.runId)} LIMIT 1`
  )[0];
  assert.deepEqual(oldState, {
    run_status: "blocked",
    step_status: "blocked",
    blocker: "portable_external_worker_timeout",
    event_count: 1,
  });
});

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

const db = await import("../db/client.js");
const { initRegisteredWorkflows } = await import("../registeredWorkflows.js");
const { startPortableWorkflowRun } = await import("../runs/portableWorkflowEntrypoint.js");
const {
  claimPortableMacWorker,
  recordPortableMacWorkerReceipt,
  requeuePortableMacWorkerAfterApproval
} = await import("../runs/portableRemoteWorker.js");

function effectAuthoritySha256(value: unknown): string {
  return createHash("sha256").update(`${JSON.stringify(value, null, 2)}\n`).digest("hex");
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
  const workerId = "mac-remote-worker-regression";
  const started = await startPortableWorkflowRun({
    workflowId: "job-application-manager",
    sourceTrigger: "automation_os_scheduler",
    idempotencyKey: "portable-remote-worker-regression",
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
      external_executor_status: "candidate_supply_readback",
      adapter_result: {
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
  assert.equal(receipt.receipt.exact_blocker, "portable_remote_read_only_business_completion_proof_pending");

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
  assert.equal(run.status, "blocked");
  assert.equal(run.company_id, companyId);
  assert.equal(metadata.external_action_executed, false);
  assert.equal(metadata.exact_blocker, "portable_remote_read_only_business_completion_proof_pending");
  const stepMetadata = JSON.parse(db.querySql<{ metadata_json: string }>(
    `SELECT metadata_json FROM run_steps WHERE run_id=${db.sqlValue(started.runId)} ORDER BY id ASC LIMIT 1`,
  )[0].metadata_json) as { service_readiness_runtime_binding?: Record<string, unknown> };
  assert.equal(stepMetadata.service_readiness_runtime_binding?.effective_session_id, "aos-effective-session");
  assert.equal(stepMetadata.service_readiness_runtime_binding?.reserved_port, 19881);
  assert.equal(stepMetadata.service_readiness_runtime_binding?.readback_status, "verified");
  assert.equal(stepMetadata.service_readiness_runtime_binding?.status, "verified");
});

test("remote Mac worker claims a business effect only after target-bound AOS approval", async () => {
  const previousMode = process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE;
  process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = "external";
  try {
    const companyId = "portable_remote_business_company";
    const started = await startPortableWorkflowRun({
      workflowId: "job-application-manager",
      sourceTrigger: "automation_os_ui",
      idempotencyKey: "portable-remote-business-regression",
      companyId,
      effectStage: "one_candidate_submit",
      inputBundle: {
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
      },
    });
    const workerId = "mac-remote-business-regression";
    assert.equal(claimPortableMacWorker({ companyId, workerId, requestedRunId: started.runId }), null);

    const { runWorkerOnce } = await import("../runs/workerEngine.js");
    await runWorkerOnce(started.runId);
    const approval = db.querySql<{ id: string }>(
      `SELECT id FROM approvals WHERE run_id=${db.sqlValue(started.runId)} ORDER BY created_at ASC LIMIT 1`
    )[0];
    assert.ok(approval);
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

test("expired portable worker claim is blocked without replay when no receipt exists", async () => {
  const companyId = "portable_remote_expired_claim_company";
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

test("candidate-supply claim waits for the persisted input bundle boundary", async () => {
  const companyId = "portable_remote_bundle_race_company";
  const started = await startPortableWorkflowRun({
    workflowId: "job-application-manager",
    sourceTrigger: "automation_os_scheduler",
    idempotencyKey: "portable-remote-bundle-race-regression",
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
    const started = await startPortableWorkflowRun({
      workflowId: "job-application-manager",
      sourceTrigger: "automation_os_scheduler",
      idempotencyKey: "portable-remote-authority-missing-regression",
      companyId,
      effectStage: "one_candidate_submit",
      inputBundle: {
        job_url: "https://www.linkedin.com/jobs/view/4405084151/",
        application_url: "https://www.linkedin.com/jobs/view/4405084151/",
        candidate_key: "opp-remote-authority-missing-regression",
        bucket: "japan_targeted",
        sequence: 1,
        attempt: 1,
        source_snapshot_id: "snapshot-remote-authority-missing-regression",
        supply_run_id: "supply-remote-authority-missing-regression",
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
    const started = await startPortableWorkflowRun({
      workflowId: "job-application-manager",
      sourceTrigger: "automation_os_ui",
      idempotencyKey: "portable-target-drift-regression",
      companyId,
      effectStage: "one_candidate_submit",
      inputBundle: {
        job_url: "https://www.linkedin.com/jobs/view/4405084152/",
        application_url: "https://www.linkedin.com/jobs/view/4405084152/",
        candidate_key: "opp-target-drift",
        bucket: "japan_targeted",
        sequence: 1,
        attempt: 1,
        source_snapshot_id: "snapshot-target-drift",
        supply_run_id: "supply-target-drift"
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
        companyId: item.companyId,
        effectStage: item.stage,
        inputBundle: item.bundle,
      });
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
    const started = await startPortableWorkflowRun({
      workflowId: "daily-ai-research-publish-run",
      sourceTrigger: "automation_os_scheduler",
      idempotencyKey: "portable-daily-business-proof-complete-regression",
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

test("approved portable business runs recover from blocked state into the Mac worker queue", async () => {
  const previousMode = process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE;
  process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = "external";
  try {
    const companyId = "portable_remote_approval_recovery_company";
    const started = await startPortableWorkflowRun({
      workflowId: "job-application-manager",
      sourceTrigger: "automation_os_scheduler",
      idempotencyKey: "portable-remote-approval-recovery-regression",
      companyId,
      effectStage: "one_candidate_submit",
      inputBundle: {
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

test("existing no-effect receipt is reconciled and cannot block a newer Mac worker candidate", async () => {
  const companyId = "portable_remote_receipt_reconciliation_company";
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

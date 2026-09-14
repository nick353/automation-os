import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

const postgresUrl = process.env.AUTOMATION_OS_TEST_POSTGRES_URL;

test("isolated PostgreSQL: Backup evidence request, failed attempt, fenced retry and atomic success", {
  skip: postgresUrl ? false : "postgres_fixture_unavailable", timeout: 180_000
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "aos-portable-backup-pg-"));
  process.env.AUTOMATION_OS_DATABASE_URL = postgresUrl;
  process.env.AUTOMATION_OS_ARTIFACT_ROOT = join(root, "artifacts");
  process.env.AUTOMATION_OS_SECRET_DIR = join(root, "secrets");
  process.env.AOS_WEB_OPERATION_BACKEND_CONFIG = join(root, "backend.json");
  process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = "external";
  process.env.AUTOMATION_OS_WORKER_ROLE = "mac";
  process.env.AUTOMATION_OS_OWNER_USER_ID = "backup_pg_owner";
  process.env.NODE_TEST_CONTEXT = "1";
  const db = await import("../db/client.js");
  await db.initializePostgresSchemaAsync();
  const backup = await import("../runs/portableLocalWorkflow.js");
  const entrypoint = await import("../runs/portableLocalWorkflowEntrypoint.js");
  const recovery = await import("../runs/portableRunRecovery.js");
  const remote = await import("../runs/portableRemoteWorker.js");
  const { app } = await import("../index.js");
  const companyId = "company_2560580981cedfd106b66245";
  const actorUserId = "backup_pg_owner";
  const now = db.nowIso();
  await db.insertAsync("users", { id: actorUserId, auth_provider: "service", auth_subject: actorUserId, email: null,
    display_name: actorUserId, kind: "service", status: "active", created_at: now, updated_at: now });
  await db.insertAsync("companies", { id: companyId, slug: "backup-pg-fixture", name: "Backup PG fixture", status: "active", created_at: now, updated_at: now });
  await db.insertAsync("company_memberships", { id: "backup_pg_membership", company_id: companyId, user_id: actorUserId,
    role: "owner", status: "active", created_at: now, updated_at: now });

  const request = (method: string, path: string, payload: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const body = method === "GET" ? "" : JSON.stringify(payload);
      const req = Readable.from(body ? [Buffer.from(body)] : []) as NodeJS.ReadableStream & { method?: string; url?: string; headers?: Record<string, string> };
      req.method = method;
      req.url = path;
      req.headers = { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), ...headers };
      const res = {
        statusCode: 200,
        setHeader() { return this; },
        getHeader() { return undefined; },
        removeHeader() { return undefined; },
        end(chunk?: string | Buffer) { resolve({ status: this.statusCode, body: JSON.parse(String(chunk ?? "{}")) }); return this; }
      };
      (app as unknown as { handle(req: unknown, res: unknown, next: (error?: unknown) => void): void }).handle(req, res, reject);
    });
  const row = async <T>(sql: string) => (await db.querySqlAsync<T>(sql))[0];
  const runId = (await entrypoint.startPortableLocalWorkflowRun({
    workflowId: "daily-backup-safety-check", sourceTrigger: "automation_os_ui", idempotencyKey: "backup-pg-original",
    companyId, readOnlyStage: "reference_readback"
  })).runId;
  const step = await row<{ id: string }>(`SELECT id FROM run_steps WHERE run_id=${db.sqlValue(runId)} LIMIT 1`);
  const initialRun = await row<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(runId)} LIMIT 1`);
  const initialMetadata = JSON.parse(initialRun.metadata_json);
  const inputBundle = { account_ref: "github:nick353/daily-workspace-backup", target_key: "daily-workspace-backup:main",
    payload_hash: backup.backupBusinessPayloadHash(), source_snapshot_id: "b".repeat(64) };
  const authority = {
    schema: "aos.portable_external_effect_authority.v1", authority_id: "authority-backup-pg",
    company_id: companyId, workflow_id: "daily-backup-safety-check", run_id: runId, step_id: step.id,
    approval_id: "approval-backup-pg", idempotency_key: "backup-pg-original", target_digest: "c".repeat(64),
    input_bundle_sha256: "a".repeat(64), payload_hash: inputBundle.payload_hash,
    issued_at: "2026-09-11T01:00:00.000Z", expires_at: "2026-09-11T02:00:00.000Z", external_action_authorized: true
  };
  const originalClaim = { run_id: runId, step_id: step.id, workflow_id: "daily-backup-safety-check", execution_mode: "business_effect",
    approval_id: authority.approval_id, idempotency_key: authority.idempotency_key, target_digest: authority.target_digest,
    input_bundle_sha256: authority.input_bundle_sha256, input_bundle: inputBundle, portable_effect_authority: authority };
  await db.execSqlAsync(`UPDATE runs SET status='blocked', metadata_json=${db.sqlValue({ ...initialMetadata,
    effect_stage: "business_execute", portable_input_bundle: { input: inputBundle, sha256: authority.input_bundle_sha256 },
    portable_workflow_invocation: { ...initialMetadata.portable_workflow_invocation, effect_stage: "business_execute" },
    portable_worker: { ...initialMetadata.portable_worker, mode: "business_effect", effect_stage: "business_execute" },
    external_action_executed: null, remote_worker_claim: originalClaim, remote_worker_receipt: undefined
  })} WHERE id=${db.sqlValue(runId)}`);

  const detail = await request("GET", `/api/v1/companies/${companyId}/runs/${runId}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  const recoveryView = await request("GET", `/api/v1/companies/${companyId}/runs/${runId}/recovery`);
  assert.equal(recoveryView.status, 200, JSON.stringify(recoveryView.body));
  const reconcile = await request("POST", `/api/v1/companies/${companyId}/runs/${runId}/recovery/reconcile-post-effect`,
    { expected_readback_token: recoveryView.body.recovery.readback_token },
    { "idempotency-key": `portable-backup-post-effect-${runId}` });
  assert.equal(reconcile.status, 200, JSON.stringify(reconcile.body));
  assert.equal(reconcile.body.response.status, "queued");

  let reconciliationBinding = await row<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(runId)} LIMIT 1`)
    .then((value) => JSON.parse(value.metadata_json).portable_post_effect_reconciliation.original_claim);
  const savedBinding = JSON.parse(JSON.stringify(reconciliationBinding));
  const first = await remote.claimPortableBackupPostEffectReconciliationAsync({ companyId, workerId: "backup-pg-worker", workerInstanceId: "backup-pg-instance-1", requestedRunId: runId });
  assert.ok(first?.attempt_id && first.fencing_token);
  const claimed = JSON.parse((await row<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(runId)} LIMIT 1`)).metadata_json);
  assert.equal(claimed.portable_post_effect_reconciliation.worker_id, "backup-pg-worker");
  assert.equal(claimed.portable_post_effect_reconciliation.worker_instance_id, "backup-pg-instance-1");
  assert.equal(claimed.portable_post_effect_reconciliation.attempt_id, first.attempt_id);
  assert.equal(claimed.portable_post_effect_reconciliation.fencing_token, first.fencing_token);
  assert.equal(claimed.portable_post_effect_reconciliation.lease_expires_at, first.lease_expires_at);
  assert.equal(await remote.claimPortableBackupPostEffectReconciliationAsync({ companyId, workerId: "backup-pg-worker", workerInstanceId: "backup-pg-instance-2", requestedRunId: runId }), null);

  const timeout = { artifact_name: "portable-local-worker-receipt.v1.json", run_id: runId, sha256: "d".repeat(64),
    status: "blocked", exact_blocker: "portable_local_child_deadline_exceeded", external_action_executed: null, no_replay: true };
  const makeReceipt = (claim: { attempt_id: string; fencing_token: string }, commit: string, stateMatches = true) => ({
    evidence_only: true, provider_replayed: false, new_effect: false, status: "complete", exact_blocker: null,
    external_action_executed: true, run_id: runId, step_id: step.id, workflow_id: "daily-backup-safety-check",
    original_run_id: runId, original_step_id: step.id, original_authority_id: authority.authority_id,
    original_authority_sha256: reconcile.body.response.original_authority_sha256, original_timeout_receipt: timeout,
    original_claim: { run_id: runId, step_id: step.id, authority_id: authority.authority_id, sha256: "e".repeat(64), authority_sha256: reconcile.body.response.original_authority_sha256 },
    attempt_id: claim.attempt_id, fencing_token: claim.fencing_token, reconciliation_binding: reconciliationBinding,
    evidence: { commit, remote_commit: commit, snapshot_id: "20260910T223116+0900", manifest_source_count: 6,
      readback_verified: true, remote_parity: true, git_integrity_verified: true, restore_verified: true,
      cleanup_verified: true, state_matches_snapshot_and_commit: stateMatches,
      original_execution_summary: { correlation_method: "unique_success_in_original_claim_interval", direct_child_link_verified: false,
        interval_start: "2026-09-11T01:00:00.000Z", interval_end: "2026-09-11T01:10:00.000Z", candidate_count: 1,
        sha256: "f".repeat(64), snapshot_id: "20260910T223116+0900", backup_commit: commit } },
    cleanup_verified: true, readback_verified: true, same_run_receipt: true, same_run_source_sync: true,
    effects_mode: "business_effect", read_only_stage_bound: false, business_completion_verified: true, business_proof_verified: true,
    browser_surface: "local_worker", connector_execution_owner: "mac_worker_explicit_connector_fallback", external_executor_status: "fixture-backup-evidence"
  });
  const firstReceipt = makeReceipt(first!, "1".repeat(40));
  const setClaimLease = async (expiresAt: string) => {
    const current = JSON.parse((await row<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(runId)} LIMIT 1`)).metadata_json);
    current.portable_post_effect_reconciliation.lease_expires_at = expiresAt;
    await db.execSqlAsync(`UPDATE runs SET metadata_json=${db.sqlValue(current)} WHERE id=${db.sqlValue(runId)}`);
  };
  const waitForLeaseExpiry = async (expiresAt: string) => {
    const remaining = Date.parse(expiresAt) - Date.now();
    if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, remaining + 100));
  };
  const expiredMetadata = JSON.parse((await row<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(runId)} LIMIT 1`)).metadata_json);
  expiredMetadata.portable_post_effect_reconciliation.lease_expires_at = "2020-01-01T00:00:00.000Z";
  await db.execSqlAsync(`UPDATE runs SET metadata_json=${db.sqlValue(expiredMetadata)} WHERE id=${db.sqlValue(runId)}`);
  await assert.rejects(() => remote.recordPortableBackupPostEffectEvidenceAsync({ companyId, workerId: "backup-pg-worker", workerInstanceId: "backup-pg-instance-1", runId, receipt: firstReceipt }), /portable_backup_evidence_lease_expired/u);
  expiredMetadata.portable_post_effect_reconciliation.lease_expires_at = first!.lease_expires_at;
  await db.execSqlAsync(`UPDATE runs SET metadata_json=${db.sqlValue(expiredMetadata)} WHERE id=${db.sqlValue(runId)}`);
  const failedLeaseExpiresAt = new Date(Date.now() + 5_000).toISOString();
  await setClaimLease(failedLeaseExpiresAt);
  const failedBefore = {
    artifacts: Number((await row<{ count: string }>(`SELECT COUNT(*) AS count FROM run_artifacts WHERE run_id=${db.sqlValue(runId)}`)).count),
    proofs: Number((await row<{ count: string }>(`SELECT COUNT(*) AS count FROM proofs WHERE run_id=${db.sqlValue(runId)}`)).count),
    run: await row<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${db.sqlValue(runId)} LIMIT 1`),
    step: await row<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM run_steps WHERE run_id=${db.sqlValue(runId)} LIMIT 1`),
    ledger: await row<{ state: string }>(`SELECT state FROM task_effect_ledger WHERE operation_key=${db.sqlValue(`backup-effect-${createHash("sha256").update(runId).digest("hex")}`)} LIMIT 1`)
  };
  let failedBarrierReached!: () => void;
  const failedBarrier = new Promise<void>((resolve) => { failedBarrierReached = resolve; });
  remote.setPortableBackupEvidenceSaveBarrierForTests(async () => {
    failedBarrierReached();
    await waitForLeaseExpiry(failedLeaseExpiresAt);
  });
  const failedSave = remote.recordPortableBackupPostEffectEvidenceAsync({ companyId, workerId: "backup-pg-worker", workerInstanceId: "backup-pg-instance-1", runId, receipt: makeReceipt(first!, "1".repeat(40), false) });
  await failedBarrier;
  await assert.rejects(() => failedSave, /sql_transaction_expected_changes:1:actual:0/u);
  remote.setPortableBackupEvidenceSaveBarrierForTests(null);
  assert.equal(Number((await row<{ count: string }>(`SELECT COUNT(*) AS count FROM run_artifacts WHERE run_id=${db.sqlValue(runId)}`)).count), failedBefore.artifacts);
  assert.equal(Number((await row<{ count: string }>(`SELECT COUNT(*) AS count FROM proofs WHERE run_id=${db.sqlValue(runId)}`)).count), failedBefore.proofs);
  assert.deepEqual(await row<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${db.sqlValue(runId)} LIMIT 1`), failedBefore.run);
  assert.deepEqual(await row<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM run_steps WHERE run_id=${db.sqlValue(runId)} LIMIT 1`), failedBefore.step);
  assert.deepEqual(await row<{ state: string }>(`SELECT state FROM task_effect_ledger WHERE operation_key=${db.sqlValue(`backup-effect-${createHash("sha256").update(runId).digest("hex")}`)} LIMIT 1`), failedBefore.ledger);

  const second = await remote.claimPortableBackupPostEffectReconciliationAsync({ companyId, workerId: "backup-pg-worker", workerInstanceId: "backup-pg-instance-2", requestedRunId: runId });
  assert.ok(second?.attempt_id && second.fencing_token);
  const failed = await remote.recordPortableBackupPostEffectEvidenceAsync({ companyId, workerId: "backup-pg-worker", workerInstanceId: "backup-pg-instance-2", runId, receipt: makeReceipt(second!, "1".repeat(40), false) });
  assert.equal(failed.receipt.status, "blocked");
  assert.ok(failed.artifact_uri);
  const failedArtifactId = failed.artifact_uri!.split("/").pop()!;
  const failedArtifact = await row<{ checksum_sha256: string; content_text: string }>(`SELECT checksum_sha256, content_text FROM run_artifacts WHERE id=${db.sqlValue(failedArtifactId)} AND run_id=${db.sqlValue(runId)} LIMIT 1`);
  assert.equal(failedArtifact.checksum_sha256, createHash("sha256").update(failedArtifact.content_text).digest("hex"));
  assert.equal(JSON.parse(failedArtifact.content_text).attempt_id, second!.attempt_id);
  assert.equal(failed.receipt.business_proof_verified, false);
  assert.equal((await row<{ state: string }>(`SELECT state FROM task_effect_ledger WHERE operation_key=${db.sqlValue(`backup-effect-${createHash("sha256").update(runId).digest("hex")}`)} LIMIT 1`)).state, "intent");
  const duplicate = await request("POST", `/api/v1/companies/${companyId}/runs/${runId}/recovery/reconcile-post-effect`,
    { expected_readback_token: "0".repeat(64) }, { "idempotency-key": `portable-backup-post-effect-${runId}` });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.replayed, true);

  const third = await remote.claimPortableBackupPostEffectReconciliationAsync({ companyId, workerId: "backup-pg-worker", workerInstanceId: "backup-pg-instance-3", requestedRunId: runId });
  assert.ok(third?.attempt_id && third.fencing_token);
  assert.notEqual(third!.attempt_id, second!.attempt_id);
  const afterRetry = JSON.parse((await row<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(runId)} LIMIT 1`)).metadata_json);
  assert.equal(afterRetry.portable_post_effect_reconciliation.attempts.at(-1).attempt_id, third!.attempt_id);
  assert.equal(afterRetry.portable_post_effect_reconciliation.lease_expires_at, third!.lease_expires_at);

  reconciliationBinding.effect_operation_key = "missing-backup-ledger";
  const rollbackMetadata = JSON.parse((await row<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(runId)} LIMIT 1`)).metadata_json);
  rollbackMetadata.portable_post_effect_reconciliation.original_claim = reconciliationBinding;
  await db.execSqlAsync(`UPDATE runs SET metadata_json=${db.sqlValue(rollbackMetadata)} WHERE id=${db.sqlValue(runId)}`);
  const beforeRollbackArtifacts = Number((await row<{ count: string }>(`SELECT COUNT(*) AS count FROM run_artifacts WHERE run_id=${db.sqlValue(runId)}`)).count);
  await assert.rejects(() => remote.recordPortableBackupPostEffectEvidenceAsync({ companyId, workerId: "backup-pg-worker", workerInstanceId: "backup-pg-instance-3", runId, receipt: makeReceipt(third!, "2".repeat(40)) }), /sql_transaction_expected_changes:1:actual:0/u);
  assert.equal(Number((await row<{ count: string }>(`SELECT COUNT(*) AS count FROM run_artifacts WHERE run_id=${db.sqlValue(runId)}`)).count), beforeRollbackArtifacts);
  assert.equal((await row<{ state: string }>(`SELECT state FROM task_effect_ledger WHERE operation_key=${db.sqlValue(`backup-effect-${createHash("sha256").update(runId).digest("hex")}`)} LIMIT 1`)).state, "intent");
  assert.equal((await row<{ status: string }>(`SELECT status FROM runs WHERE id=${db.sqlValue(runId)} LIMIT 1`)).status, "blocked");

  reconciliationBinding = savedBinding;
  const restoredMetadata = JSON.parse((await row<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(runId)} LIMIT 1`)).metadata_json);
  restoredMetadata.portable_post_effect_reconciliation.original_claim = reconciliationBinding;
  await db.execSqlAsync(`UPDATE runs SET metadata_json=${db.sqlValue(restoredMetadata)} WHERE id=${db.sqlValue(runId)}`);
  const successBefore = {
    artifacts: Number((await row<{ count: string }>(`SELECT COUNT(*) AS count FROM run_artifacts WHERE run_id=${db.sqlValue(runId)}`)).count),
    proofs: Number((await row<{ count: string }>(`SELECT COUNT(*) AS count FROM proofs WHERE run_id=${db.sqlValue(runId)}`)).count),
    run: await row<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${db.sqlValue(runId)} LIMIT 1`),
    step: await row<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM run_steps WHERE run_id=${db.sqlValue(runId)} LIMIT 1`),
    ledger: await row<{ state: string }>(`SELECT state FROM task_effect_ledger WHERE operation_key=${db.sqlValue(`backup-effect-${createHash("sha256").update(runId).digest("hex")}`)} LIMIT 1`)
  };
  const successLeaseExpiresAt = new Date(Date.now() + 5_000).toISOString();
  await setClaimLease(successLeaseExpiresAt);
  successBefore.run = await row<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${db.sqlValue(runId)} LIMIT 1`);
  let successBarrierReached!: () => void;
  const successBarrier = new Promise<void>((resolve) => { successBarrierReached = resolve; });
  remote.setPortableBackupEvidenceSaveBarrierForTests(async () => {
    successBarrierReached();
    await waitForLeaseExpiry(successLeaseExpiresAt);
  });
  const expiredSuccessSave = remote.recordPortableBackupPostEffectEvidenceAsync({ companyId, workerId: "backup-pg-worker", workerInstanceId: "backup-pg-instance-3", runId, receipt: makeReceipt(third!, "2".repeat(40)) });
  await successBarrier;
  await assert.rejects(() => expiredSuccessSave, /sql_transaction_expected_changes:1:actual:0/u);
  remote.setPortableBackupEvidenceSaveBarrierForTests(null);
  assert.equal(Number((await row<{ count: string }>(`SELECT COUNT(*) AS count FROM run_artifacts WHERE run_id=${db.sqlValue(runId)}`)).count), successBefore.artifacts);
  assert.equal(Number((await row<{ count: string }>(`SELECT COUNT(*) AS count FROM proofs WHERE run_id=${db.sqlValue(runId)}`)).count), successBefore.proofs);
  assert.deepEqual(await row<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${db.sqlValue(runId)} LIMIT 1`), successBefore.run);
  assert.deepEqual(await row<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM run_steps WHERE run_id=${db.sqlValue(runId)} LIMIT 1`), successBefore.step);
  assert.deepEqual(await row<{ state: string }>(`SELECT state FROM task_effect_ledger WHERE operation_key=${db.sqlValue(`backup-effect-${createHash("sha256").update(runId).digest("hex")}`)} LIMIT 1`), successBefore.ledger);

  const fourth = await remote.claimPortableBackupPostEffectReconciliationAsync({ companyId, workerId: "backup-pg-worker", workerInstanceId: "backup-pg-instance-4", requestedRunId: runId });
  assert.ok(fourth?.attempt_id && fourth.fencing_token);
  const success = await remote.recordPortableBackupPostEffectEvidenceAsync({ companyId, workerId: "backup-pg-worker", workerInstanceId: "backup-pg-instance-4", runId, receipt: makeReceipt(fourth!, "2".repeat(40)) });
  assert.equal(success.receipt.status, "complete");
  assert.equal((await row<{ state: string }>(`SELECT state FROM task_effect_ledger WHERE operation_key=${db.sqlValue(`backup-effect-${createHash("sha256").update(runId).digest("hex")}`)} LIMIT 1`)).state, "closed");
  assert.equal(Number((await row<{ count: string }>(`SELECT COUNT(*) AS count FROM run_artifacts WHERE run_id=${db.sqlValue(runId)}`)).count), 2);
  assert.ok(await row<{ id: string }>(`SELECT id FROM run_artifacts WHERE id=${db.sqlValue(failedArtifactId)} AND run_id=${db.sqlValue(runId)} LIMIT 1`));
  const replay = await remote.recordPortableBackupPostEffectEvidenceAsync({ companyId, workerId: "backup-pg-worker", workerInstanceId: "backup-pg-instance-4", runId, receipt: makeReceipt(fourth!, "2".repeat(40)) });
  assert.equal(replay.replayed, true);
  assert.equal(replay.artifact_uri, success.artifact_uri);
  await assert.rejects(() => remote.recordPortableBackupPostEffectEvidenceAsync({ companyId, workerId: "backup-pg-worker", workerInstanceId: "backup-pg-instance-4", runId, receipt: makeReceipt(fourth!, "3".repeat(40)) }), /portable_backup_evidence_conflict/u);

  const finalRecovery = await request("GET", `/api/v1/companies/${companyId}/runs/${runId}/recovery`);
  assert.equal(finalRecovery.status, 200, JSON.stringify(finalRecovery.body));
  assert.equal(finalRecovery.body.recovery.status, "complete");
  assert.equal(finalRecovery.body.recovery.external_action_executed, true);
  assert.equal(finalRecovery.body.recovery.can_retry, false);
  assert.equal(finalRecovery.body.recovery.backup_post_effect_reconciliation.status, "verified");
  const finalDetail = await request("GET", `/api/v1/companies/${companyId}/runs/${runId}`);
  assert.equal(finalDetail.status, 200);
  assert.equal(finalDetail.body.run.id, runId);
});

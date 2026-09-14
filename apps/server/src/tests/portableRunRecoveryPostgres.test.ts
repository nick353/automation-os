import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

const postgresUrl = process.env.AUTOMATION_OS_TEST_POSTGRES_URL;
test("isolated PostgreSQL: company Run recovery cancels before claim and admits only one no-effect retry", {
  skip: postgresUrl ? false : "postgres_fixture_unavailable", timeout: 180_000
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aos-portable-recovery-pg-"));
  process.env.AUTOMATION_OS_DATABASE_URL = postgresUrl;
  process.env.AUTOMATION_OS_ARTIFACT_ROOT = join(root, "artifacts");
  process.env.AUTOMATION_OS_SECRET_DIR = join(root, "secrets");
  process.env.AOS_WEB_OPERATION_BACKEND_CONFIG = join(root, "backend.json");
  process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = "external";
  process.env.AUTOMATION_OS_WORKER_ROLE = "mac";
  process.env.AUTOMATION_OS_OWNER_USER_ID = "portable_recovery_fixture_owner";
  process.env.NODE_TEST_CONTEXT = "1";
  const db = await import("../db/client.js");
  await db.initializePostgresSchemaAsync();
  const daily = await import("../runs/dailyAiResearchSourceSync.js");
  const { startPortableLocalWorkflowRun } = await import("../runs/portableLocalWorkflowEntrypoint.js");
  const repository = await import("../automations/repository.js");
  const recovery = await import("../runs/portableRunRecovery.js");
  const { claimPortableMacWorkerAsync: claimWorker, recordPortableMacWorkerReceiptAsync: recordReceipt } = await import("../runs/portableRemoteWorker.js");
  const companyId = daily.DAILY_AI_RESEARCH_SYNC_COMPANY;
  const actorUserId = process.env.AUTOMATION_OS_OWNER_USER_ID;
  const now = db.nowIso();
  await db.insertAsync("users", { id: actorUserId, auth_provider: "service", auth_subject: actorUserId, email: null,
    display_name: actorUserId, kind: "service", status: "active", created_at: now, updated_at: now });
  await db.insertAsync("companies", { id: companyId, slug: "portable-recovery-fixture", name: "Isolated fixture", status: "active", created_at: now, updated_at: now });
  await db.insertAsync("company_memberships", { id: "portable_recovery_fixture_member", company_id: companyId, user_id: actorUserId,
    role: "owner", status: "active", created_at: now, updated_at: now });
  const createSource = (workflow: string, kind: string) => repository.createAutomationRecordAsync({ companyId, actorUserId, definition: {
    automationType: "registered_workflow", name: `Fixture ${workflow}`, description: "No provider calls in this fixture",
    goal: "Bound recovery", lane: "local", riskLevel: "low", approvalPolicy: "required_before_external_action",
    workerCommandKind: kind, createApproval: false,
    builderSpec: { schema: "aos.registered_automation_adoption.v1", canonicalWorkflowId: workflow, browserSurface: "none" }
  } });
  const source = await createSource(daily.DAILY_AI_RESEARCH_SYNC_WORKFLOW, "daily_ai_research_sync_registered");
  const readSource = await createSource("email-review-reply", "email_review_registered");
  const { app } = await import("../index.js");
  const request = (method: string, path: string, payload: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const body = method === "GET" ? "" : JSON.stringify(payload);
      const req = Readable.from(body ? [Buffer.from(body)] : []) as NodeJS.ReadableStream & { method?: string; url?: string; headers?: Record<string, string> };
      req.method = method; req.url = path;
      req.headers = { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), ...headers };
      const res = { statusCode: 200, setHeader() { return this; }, getHeader() { return undefined; }, removeHeader() { return undefined; },
        end(chunk?: string | Buffer) { resolve({ status: this.statusCode, body: JSON.parse(String(chunk ?? "{}")) }); return this; } };
      (app as unknown as { handle(req: unknown, res: unknown, next: (error?: unknown) => void): void }).handle(req, res, reject);
    });
  const runFor = async (id: string) => (await db.querySqlAsync<any>(`SELECT * FROM runs WHERE id=${db.sqlValue(id)}`))[0];
  const approvalFor = async (runId: string) => (await db.querySqlAsync<any>(`SELECT * FROM approvals WHERE run_id=${db.sqlValue(runId)} ORDER BY created_at`))[0];
  const read = async (runId: string) => {
    // Fail with the exact local query error before checking its public API
    // projection. This fixture contains no live provider or user data.
    await recovery.readPortableRunRecovery({ companyId, runId });
    const response = await request("GET", `/api/v1/companies/${companyId}/runs/${runId}/recovery`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.recovery.run_id, runId);
    assert.equal(response.body.recovery.company_id, companyId);
    return response.body.recovery;
  };
  const action = (runId: string, action: string, token: string, key = `portable-retry-${runId}`) =>
    request("POST", `/api/v1/companies/${companyId}/runs/${runId}/recovery/${action}`,
      { expected_readback_token: token }, { "idempotency-key": key });
  const prepare = async (readOnly = false) => {
    const idempotencyKey = db.makeId("fixture");
    const admission = daily.prepareDailyAiResearchSyncAdmission({ companyId, dueKey: idempotencyKey, scheduledFor: db.nowIso() });
    const started = await startPortableLocalWorkflowRun({ companyId, workflowId: readOnly ? "email-review-reply" : daily.DAILY_AI_RESEARCH_SYNC_WORKFLOW,
      sourceTrigger: "automation_os_ui", registeredAutomationId: readOnly ? readSource.id : source.id,
      registeredAutomationVersionId: readOnly ? readSource.currentVersionId : source.currentVersionId, idempotencyKey,
      ...(readOnly ? { readOnlyStage: "reference_readback" as const } : { effectStage: "business_execute" as const,
        inputBundle: admission.inputBundle, sourceSnapshot: admission.sourceSnapshot }) });
    return { runId: started.runId, view: await read(started.runId) };
  };
  const cancel = async (runId: string) => {
    const response = await action(runId, "cancel", (await read(runId)).readback_token);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return read(runId);
  };

  await t.test("UI API cancels Run, steps and pending approval; replay is a no-op and worker cannot claim", async () => {
    const { runId, view } = await prepare();
    assert.equal(view.can_cancel, true);
    assert.equal(view.external_action_executed, false);
    assert.equal(view.can_retry, false);
    const after = await cancel(runId);
    assert.equal(after.status, "cancelled");
    assert.equal(after.can_retry, true);
    assert.equal((await approvalFor(runId)).status, "cancelled");
    const persisted = await runFor(runId);
    assert.equal((await action(runId, "cancel", view.readback_token)).body.replayed, true);
    assert.deepEqual(await runFor(runId), persisted);
    assert.equal(await claimWorker({ companyId, workerId: "fixture_cancelled", requestedRunId: runId }), null);
    const steps = await db.querySqlAsync<any>(`SELECT status, started_at FROM run_steps WHERE run_id=${db.sqlValue(runId)}`);
    assert.ok(steps.length && steps.every((step) => step.status === "cancelled" && !step.started_at));
  });

  await t.test("concurrent retry and lost completion use one child and one fresh approval without rewriting parent history", async () => {
    const { runId } = await prepare();
    const oldApproval = await approvalFor(runId);
    const view = await cancel(runId);
    const original = await runFor(runId);
    const responses = await Promise.all([action(runId, "retry", view.readback_token), action(runId, "retry", view.readback_token)]);
    assert.ok(responses.some((row) => row.status === 200), JSON.stringify(responses));
    assert.ok(responses.every((row) => [200, 409].includes(row.status)), JSON.stringify(responses));
    const after = await read(runId);
    assert.equal(after.retry.result_confirmed, true);
    assert.equal(after.can_retry, false);
    const childId = after.retry.run_id;
    assert.notEqual(childId, runId);
    const child = await runFor(childId);
    assert.equal(child.status, "waiting_approval");
    assert.equal(child.company_id, companyId);
    assert.equal(child.automation_version_id, original.automation_version_id);
    const metadata = JSON.parse(child.metadata_json);
    assert.equal(metadata.recovery_origin.parent_run_id, runId);
    assert.equal(metadata.unattended_effect_policy, undefined);
    const approval = await approvalFor(childId);
    assert.equal(approval.status, "pending");
    assert.notEqual(approval.id, oldApproval.id);
    assert.equal(approval.target_account_ref_id, oldApproval.target_account_ref_id);
    assert.equal(approval.payload_hash, oldApproval.payload_hash);
    assert.notEqual(metadata.portable_input_bundle.input.source_snapshot_id, JSON.parse(original.metadata_json).portable_input_bundle.input.source_snapshot_id);
    assert.equal(await claimWorker({ companyId, workerId: "fixture_unapproved", requestedRunId: childId }), null);
    await db.querySqlAsync(`UPDATE runs SET status='preparing' WHERE id=${db.sqlValue(childId)}`);
    const preparing = await read(runId);
    assert.equal(preparing.retry.result_confirmed, false);
    assert.equal(preparing.can_retry, false);
    assert.equal(preparing.retry_blocker, "portable_recovery_retry_preparing");
    await db.querySqlAsync(`UPDATE runs SET status='waiting_approval' WHERE id=${db.sqlValue(childId)}`);
    await db.querySqlAsync(`UPDATE portable_workflow_invocations SET run_id=NULL, status='pending' WHERE run_id=${db.sqlValue(childId)}`);
    const lost = await action(runId, "retry", view.readback_token);
    assert.equal(lost.status, 200);
    assert.equal(lost.body.retry_run.id, childId);
    assert.deepEqual(await runFor(runId), original);
    assert.equal((await action(runId, "retry", view.readback_token, "a-different-key")).status, 400);
    await cancel(childId);
  });

  await t.test("expired approval is not reused; cancelled parent gets a new pending approval", async () => {
    const { runId } = await prepare();
    await db.querySqlAsync(`UPDATE approvals SET expires_at='2020-01-01T00:00:00.000Z' WHERE run_id=${db.sqlValue(runId)}`);
    const expired = await approvalFor(runId);
    const stopped = await cancel(runId);
    const retry = await action(runId, "retry", stopped.readback_token);
    assert.equal(retry.status, 200);
    const next = await approvalFor(retry.body.retry_run.id);
    assert.notEqual(next.id, expired.id);
    assert.ok(Date.parse(next.expires_at) > Date.now());
    const oldDecision = await request("PATCH", `/api/mvp/approvals/${expired.id}`, { decision: "approve" });
    assert.equal(oldDecision.status, 409);
    await cancel(retry.body.retry_run.id);
  });

  await t.test("approved retry executes once with a fixture-only mirror receipt and leaves the cancelled parent intact", async () => {
    const { runId } = await prepare();
    const stopped = await cancel(runId);
    const parent = await runFor(runId);
    const prepared = await action(runId, "retry", stopped.readback_token);
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    const childId = prepared.body.retry_run.id;
    const approval = await approvalFor(childId);
    const approved = await request("PATCH", `/api/mvp/approvals/${approval.id}`, { decision: "approve", note: "Fixture only; no provider calls",
      expected_binding: Object.fromEntries(["company_id", "run_id", "action_kind", "target_account_ref_id", "payload_hash", "policy_version", "expires_at"]
        .map((field) => [field, approval[field] ?? null])) });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const claim = await claimWorker({ companyId, workerId: "fixture_retry_worker", requestedRunId: childId });
    assert.ok(claim?.effect_authority && claim.approval_receipt);
    assert.equal(claim.run_id, childId);
    assert.equal(claim.input_bundle?.target_key, daily.DAILY_AI_RESEARCH_SYNC_TARGET);
    const local = await daily.runDailyAiResearchSourceSyncBusiness({ workflowId: claim.workflow_id, companyId, workerRole: "mac",
      runId: claim.run_id, stepId: claim.step_id, idempotencyKey: claim.idempotency_key, targetDigest: claim.target_digest!,
      inputBundleSha256: claim.input_bundle_sha256!, inputBundle: claim.input_bundle!, authorityExpiresAt: claim.effect_authority.expires_at },
    async (binding) => ({ ...binding, workflow_id: claim.workflow_id, status: "complete", exact_blocker: null,
      external_action_executed: true, same_run_receipt: true, same_run_source_sync: true, readback_verified: true, cleanup_verified: true,
      full_publish_completed: false, generation_performed: false, mirror: { spreadsheet_id: daily.DAILY_AI_RESEARCH_SYNC_SHEET,
        sheet_id: 1541274581, mirror_column_count: 39, all_local_ids_and_columns_match: true, manual_views_match: true },
      research: { metrics: { published: 0, sheets_synced: 0, auto_promoted: 0 } },
      business_proofs: { research_queue: true, existing_sheet_mirror: true, all_mirror_columns: true, cleanup_receipt: true } }));
    const receipt = { ...local, browser_surface: "local_worker", run_id: claim.run_id, step_id: claim.step_id,
      effects_mode: "business_effect", business_effect_stage: claim.business_effect_stage, target_digest: claim.target_digest,
      input_bundle_sha256: claim.input_bundle_sha256, approval_receipt: claim.approval_receipt,
      effect_authority_id: claim.effect_authority.authority_id,
      effect_authority_sha256: createHash("sha256").update(`${JSON.stringify(claim.effect_authority, null, 2)}\n`).digest("hex"),
      external_executor_status: "fixture_retry_mirror", web_operation_lifecycle: {
        schema: "automation_os_web_operation_lifecycle.v1", state: "completed", status: "complete", exact_blocker: null,
        run_id: claim.run_id, step_id: claim.step_id, idempotency_key: claim.idempotency_key, operation: "update",
        target_digest: claim.target_digest, payload_hash: claim.effect_authority.payload_hash, external_action_executed: true,
        same_run_receipt: true, readback_verified: true, cleanup_verified: true, no_replay: true } };
    const recorded = await recordReceipt({ companyId, workerId: "fixture_retry_worker", runId: childId, receipt });
    assert.equal(recorded.receipt.business_proof_verified, true);
    assert.equal((await runFor(childId)).status, "complete");
    assert.equal((await action(runId, "retry", stopped.readback_token)).body.retry_run.id, childId);
    assert.equal(await claimWorker({ companyId, workerId: "fixture_retry_worker", requestedRunId: childId }), null);
    assert.deepEqual(await runFor(runId), parent);
    assert.equal((await read(childId)).can_retry, false);
  });

  await t.test("positive and unknown effect evidence at Run or step level suppress all replay and remain unchanged", async () => {
    for (const effect of [true, null] as const) {
      for (const location of ["run", "step"]) {
        const { runId } = await prepare();
        const before = await runFor(runId);
        const metadata = { ...JSON.parse(before.metadata_json), external_action_executed: location === "run" ? effect : false };
        await db.querySqlAsync(`UPDATE runs SET status='blocked', metadata_json=${db.sqlValue(metadata)} WHERE id=${db.sqlValue(runId)}`);
        if (location === "step") await db.querySqlAsync(`UPDATE run_steps SET metadata_json=${db.sqlValue({ external_action_executed: effect })} WHERE run_id=${db.sqlValue(runId)}`);
        const persisted = await runFor(runId);
        const view = await read(runId);
        assert.equal(view.can_cancel, false);
        assert.equal(view.can_retry, false);
        assert.equal(view.external_action_executed, effect);
        assert.equal((await action(runId, "retry", view.readback_token)).status, 409);
        assert.deepEqual(await runFor(runId), persisted);
      }
    }
  });

  await t.test("stale state and changed registered version are rejected; original fixed target cannot be replaced", async () => {
    const { runId, view } = await prepare();
    const raw = await runFor(runId);
    const metadata = { ...JSON.parse(raw.metadata_json), fixture_revision: 2 };
    await db.querySqlAsync(`UPDATE runs SET metadata_json=${db.sqlValue(metadata)} WHERE id=${db.sqlValue(runId)}`);
    assert.equal((await action(runId, "cancel", view.readback_token)).body.error, "portable_recovery_readback_changed");
    const stopped = await cancel(runId);
    await db.querySqlAsync(`UPDATE mvp_automations SET current_version_id=${db.sqlValue(readSource.currentVersionId)} WHERE id=${db.sqlValue(source.id)}`);
    assert.equal((await read(runId)).retry_blocker, "portable_recovery_registration_changed");
    assert.equal((await action(runId, "retry", stopped.readback_token)).status, 409);
    await db.querySqlAsync(`UPDATE mvp_automations SET current_version_id=${db.sqlValue(source.currentVersionId)} WHERE id=${db.sqlValue(source.id)}`);
    const current = await runFor(runId);
    const changed = JSON.parse(current.metadata_json);
    changed.portable_input_bundle.input.target_key = "foreign-sheet";
    await db.querySqlAsync(`UPDATE runs SET metadata_json=${db.sqlValue(changed)} WHERE id=${db.sqlValue(runId)}`);
    const response = await action(runId, "retry", (await read(runId)).readback_token);
    assert.equal(response.body.error, "portable_recovery_fixed_target_changed");
    assert.equal((await read(runId)).retry, null);
  });

  await t.test("cancellation and read-only worker claim have only one winner", async () => {
    const { runId, view } = await prepare(true);
    assert.equal(view.can_cancel, true, "legacy read-only admission timestamp is not a worker claim");
    const results = await Promise.allSettled([
      action(runId, "cancel", view.readback_token),
      claimWorker({ companyId, workerId: "fixture_race", requestedRunId: runId })
    ]);
    const run = await runFor(runId);
    if (run.status === "cancelled") {
      assert.ok(results[1].status === "rejected" || results[1].value === null);
      assert.equal(JSON.parse(run.metadata_json).remote_worker_claim, undefined);
    } else {
      assert.equal(run.status, "running");
      assert.ok(JSON.parse(run.metadata_json).remote_worker_claim);
      assert.ok(results[0].status === "fulfilled" && results[0].value.status === 409);
      const latest = await read(runId);
      assert.equal(latest.can_cancel, false);
      assert.equal(latest.can_retry, false);
    }
  });

  await t.test("expired read-only claim is reconciled before a new child; expired business claim remains unknown", async () => {
    const { runId } = await prepare(true);
    const claim = await claimWorker({ companyId, workerId: "fixture_expire", requestedRunId: runId });
    assert.ok(claim);
    const raw = await runFor(runId);
    const metadata = JSON.parse(raw.metadata_json);
    metadata.remote_worker_claim.lease_expires_at = "2020-01-01T00:00:00.000Z";
    await db.querySqlAsync(`UPDATE runs SET metadata_json=${db.sqlValue(metadata)} WHERE id=${db.sqlValue(runId)}`);
    assert.equal((await read(runId)).can_retry, false, "lease timeout alone is not reconciliation");
    assert.equal(await claimWorker({ companyId, workerId: "fixture_reconcile", requestedRunId: runId }), null);
    const reconciled = await read(runId);
    assert.equal(reconciled.external_action_executed, false);
    assert.equal(reconciled.can_retry, true);
    const result = await action(runId, "retry", reconciled.readback_token);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.retry_run.status, "queued");
    await cancel(result.body.retry_run.id);
    const business = await prepare();
    const original = await runFor(business.runId);
    await db.querySqlAsync(`UPDATE runs SET status='running', metadata_json=${db.sqlValue({ ...JSON.parse(original.metadata_json),
      remote_worker_claim: { worker_id: "fixture_lost", claimed_at: "2020-01-01T00:00:00.000Z", lease_expires_at: "2020-01-01T00:01:00.000Z", execution_mode: "business_effect" } })}
      WHERE id=${db.sqlValue(business.runId)}`);
    assert.equal(await claimWorker({ companyId, workerId: "fixture_reconcile_business", requestedRunId: business.runId }), null);
    const unknown = await read(business.runId);
    assert.equal(unknown.external_action_executed, null);
    assert.equal(unknown.can_retry, false);
  });

  await t.test("company, role, body and operation binding are enforced without provider calls", async () => {
    const { runId, view } = await prepare();
    await assert.rejects(() => recovery.readPortableRunRecovery({ companyId: "foreign", runId }), /run_not_found/u);
    const foreign = await request("GET", `/api/v1/companies/foreign/runs/${runId}/recovery`);
    assert.equal(foreign.status, 404);
    const body = await request("POST", `/api/v1/companies/${companyId}/runs/${runId}/recovery/cancel`,
      { expected_readback_token: view.readback_token, input_bundle: {} });
    assert.equal(body.status, 400);
    await db.querySqlAsync("UPDATE company_memberships SET role='viewer' WHERE id='portable_recovery_fixture_member'");
    assert.equal((await read(runId)).run_id, runId);
    assert.notEqual((await action(runId, "cancel", view.readback_token)).status, 200);
    assert.equal((await runFor(runId)).status, "waiting_approval");
  });
});

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-registered-e2e-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");
process.env.NODE_TEST_CONTEXT = "1";
process.env.AUTOMATION_OS_WORKER_ROLE = "mac";

const db = await import("../db/client.js");
const { adoptRegisteredAutomationCatalog } = await import("../automations/registeredCatalog.js");
const { materializeDuePortableAutomationOccurrences } = await import("../runs/portableAutomationScheduler.js");
const { startPortableWorkflowRun } = await import("../runs/portableWorkflowEntrypoint.js");
const { startPortableLocalWorkflowRun } = await import("../runs/portableLocalWorkflowEntrypoint.js");
const { runWorkerOnce } = await import("../runs/workerEngine.js");
const { runPortableLocalWorkflowReadOnly } = await import("../runs/portableLocalWorkflow.js");
const { buildDefaultProjectRegistry } = await import("../projects/defaultProjectRegistry.js");
const { buildRegistryEntry } = await import("../projects/projectAuditor.js");

db.initDb();
process.env.AUTOMATION_OS_ARTIFACT_ROOT = join(tempRoot, "artifacts");

const createdAt = "2026-08-11T00:00:00.000Z";
const companyId = "e2e-registered-company";
const ownerId = "e2e-registered-owner";
const serviceUserId = "e2e-registered-service";
db.insert("users", { id: ownerId, auth_provider: "test", auth_subject: ownerId, email: null, display_name: ownerId, kind: "human", status: "active", created_at: createdAt, updated_at: createdAt });
db.insert("users", { id: serviceUserId, auth_provider: "service", auth_subject: serviceUserId, email: null, display_name: serviceUserId, kind: "service", status: "active", created_at: createdAt, updated_at: createdAt });
db.insert("companies", { id: companyId, slug: companyId, name: companyId, status: "active", created_at: createdAt, updated_at: createdAt });
db.insert("company_memberships", { id: "e2e-registered-owner-membership", company_id: companyId, user_id: ownerId, role: "owner", status: "active", created_at: createdAt, updated_at: createdAt });
db.insert("company_memberships", { id: "e2e-registered-service-membership", company_id: companyId, user_id: serviceUserId, role: "operator", status: "active", created_at: createdAt, updated_at: createdAt });

test("all six registered entries share a control-plane adapter and portable dispatch", async () => {
  const adopted = adoptRegisteredAutomationCatalog({ companyId, actorUserId: ownerId, enableSchedules: true });
  assert.equal(adopted.adopted.length, 6);
  assert.ok(adopted.adopted.every((item) => item.adoption.workflowAdapter !== null));
  assert.ok(adopted.adopted.every((item) => item.adoption.portableDispatch !== null));
  assert.ok(adopted.adopted.every((item) => item.adoption.externalActionAllowed === false));

  for (const item of adopted.adopted) {
    db.execSql(`UPDATE mvp_automation_schedules SET next_run_at=${db.sqlValue("2026-08-11T00:30:00.000Z")} WHERE id=${db.sqlValue(item.schedule.id)}`);
  }

  const materialized = await materializeDuePortableAutomationOccurrences({
    companyId,
    serviceUserId,
    now: "2026-08-11T00:30:00.000Z"
  });
  assert.equal(materialized.runIds.length, 6);
  assert.equal(materialized.portableScheduleIds.length, 6);
  assert.deepEqual(materialized.workflowIds.sort(), [
    "daily-ai-research-publish-run",
    "job-application-manager",
    "nisenprints-daily-product-canva-printify-etsy-pinterest"
  ].sort());
  assert.deepEqual(materialized.localWorkflowIds.sort(), [
    "daily-backup-safety-check",
    "email-review-reply",
    "obsidian-project-memory-audit"
  ].sort());
  assert.equal(db.querySql<{ count: number }>(`SELECT count(*) AS count FROM durable_jobs WHERE company_id=${db.sqlValue(companyId)}`)[0].count, 0);

  const runRows = db.querySql<{ id: string; metadata_json: string; company_id: string | null }>(
    `SELECT id, metadata_json, company_id FROM runs WHERE id IN (${materialized.runIds.map((id) => db.sqlValue(id)).join(",")}) ORDER BY id`
  );
  assert.equal(runRows.length, 6);
  assert.ok(runRows.every((row) => row.company_id === companyId));
  assert.ok(runRows.every((row) => JSON.parse(row.metadata_json).portable_worker?.external_action_executed === false));
  assert.ok(runRows.every((row) => JSON.parse(row.metadata_json).worker_mode === "queued_for_mac_worker"));

  const replayedSchedule = await materializeDuePortableAutomationOccurrences({
    companyId,
    serviceUserId,
    now: "2026-08-11T00:30:00.000Z"
  });
  assert.deepEqual(replayedSchedule.runIds, []);
  assert.deepEqual(replayedSchedule.blocked, []);
});

test("registered browser and local starts are idempotent and reject same-key payload drift", async () => {
  const browserStart = await startPortableWorkflowRun({
    workflowId: "job-application-manager",
    sourceTrigger: "automation_os_ui",
    idempotencyKey: "e2e-registered-browser-idempotency",
    companyId,
    readOnlyStage: "candidate_supply"
  });
  const browserReplay = await startPortableWorkflowRun({
    workflowId: "job-application-manager",
    sourceTrigger: "automation_os_ui",
    idempotencyKey: "e2e-registered-browser-idempotency",
    companyId,
    readOnlyStage: "candidate_supply"
  });
  assert.equal(browserReplay.replayed, true);
  assert.equal(browserReplay.runId, browserStart.runId);
  await assert.rejects(
    startPortableWorkflowRun({
      workflowId: "job-application-manager",
      sourceTrigger: "automation_os_ui",
      idempotencyKey: "e2e-registered-browser-idempotency",
      companyId,
      readOnlyStage: "candidate_supply",
      inputBundle: { candidate_key: "payload-drift" }
    }),
    /portable_workflow_invocation_payload_conflict/
  );

  const localStart = await startPortableLocalWorkflowRun({
    workflowId: "email-review-reply",
    sourceTrigger: "automation_os_ui",
    idempotencyKey: "e2e-registered-local-idempotency",
    companyId,
    readOnlyStage: "reference_readback"
  });
  const localReplay = await startPortableLocalWorkflowRun({
    workflowId: "email-review-reply",
    sourceTrigger: "automation_os_ui",
    idempotencyKey: "e2e-registered-local-idempotency",
    companyId,
    readOnlyStage: "reference_readback"
  });
  assert.equal(localReplay.replayed, true);
  assert.equal(localReplay.runId, localStart.runId);
  const localDifferentSource = await startPortableLocalWorkflowRun({
    workflowId: "email-review-reply",
    sourceTrigger: "launchd",
    idempotencyKey: "e2e-registered-local-idempotency",
    companyId,
    readOnlyStage: "reference_readback"
  });
  assert.equal(localDifferentSource.replayed, false);
  assert.notEqual(localDifferentSource.runId, localStart.runId);
});

test("local worker E2E preserves read-only, exact blockers, and cleanup truth", () => {
  const backupRunner = join(tempRoot, "e2e-backup-runner.sh");
  writeFileSync(backupRunner, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  chmodSync(backupRunner, 0o700);
  process.env.AUTOMATION_OS_BACKUP_RUNNER_PATH = backupRunner;

  const projectRoot = join(tempRoot, "e2e-obsidian-project");
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, "STATE.md"), "# E2E project state\n", { mode: 0o600 });
  const registry = { ...buildDefaultProjectRegistry(), projects: [buildRegistryEntry({ id: "e2e-project", label: "E2E project", root: projectRoot })] };
  const registryPath = join(tempRoot, "e2e-project-registry.json");
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  process.env.AUTOMATION_OS_PROJECT_REGISTRY = registryPath;
  process.env.AUTOMATION_OS_OBSIDIAN_VAULT = join(tempRoot, "e2e-vault");
  mkdirSync(process.env.AUTOMATION_OS_OBSIDIAN_VAULT, { recursive: true });

  const email = runPortableLocalWorkflowReadOnly({ workflowId: "email-review-reply", workerRole: "mac" });
  assert.equal(email.status, "blocked");
  assert.equal(email.exact_blocker, "gmail_connector_context_isolation_unavailable");
  assert.equal(email.external_action_executed, false);
  assert.equal(email.cleanup_verified, true);
  assert.equal(email.business_completion_verified, false);

  const backup = runPortableLocalWorkflowReadOnly({ workflowId: "daily-backup-safety-check", workerRole: "mac" });
  assert.equal(backup.status, "partial");
  assert.equal(backup.exact_blocker, "local_backup_effect_requires_explicit_approval");
  assert.equal(backup.external_action_executed, false);
  assert.equal(backup.cleanup_verified, true);
  assert.equal(backup.business_completion_verified, false);

  const obsidian = runPortableLocalWorkflowReadOnly({ workflowId: "obsidian-project-memory-audit", workerRole: "mac" });
  assert.ok(obsidian.status === "partial" || obsidian.status === "blocked");
  assert.equal(obsidian.external_action_executed, false);
  assert.equal(obsidian.cleanup_verified, true);
  assert.equal(obsidian.business_completion_verified, false);
  assert.ok(obsidian.exact_blocker === "obsidian_artifact_write_requires_approval" || obsidian.exact_blocker === "unresolved_only_audit_failed");
});

test("local worker refuses the wrong execution role before any adapter work", () => {
  const result = runPortableLocalWorkflowReadOnly({ workflowId: "obsidian-project-memory-audit", workerRole: "remote" });
  assert.equal(result.status, "blocked");
  assert.equal(result.exact_blocker, "mac_worker_required");
  assert.equal(result.external_action_executed, false);
  assert.equal(result.cleanup_verified, true);
});

test("portable external reference readback explicitly cannot claim business completion", async () => {
  const previousMode = process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE;
  const previousRunner = process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER;
  const previousEffects = process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS;
  const previousApproval = process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL;
  const runner = join(tempRoot, "reference-readback-runner.mjs");
  writeFileSync(runner, "#!/usr/bin/env node\nconsole.log(JSON.stringify({ status: 'complete', external_action_executed: false, browser_surface: 'browser_use_cli' }));\n", { mode: 0o700 });
  chmodSync(runner, 0o700);
  process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = "external";
  process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER = runner;
  process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS = "read_only";
  process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL = "approved";
  try {
    const started = await startPortableWorkflowRun({
      workflowId: "nisenprints-daily-product-canva-printify-etsy-pinterest",
      sourceTrigger: "automation_os_ui",
      idempotencyKey: "e2e-reference-readback-business-completion-boundary",
      companyId,
      readOnlyStage: "reference_readback"
    });
    const processed = await runWorkerOnce(started.runId);
    assert.equal(processed.length, 1);
    const run = db.querySql<{ status: string; metadata_json: string }>(
      `SELECT status, metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`
    )[0];
    const metadata = JSON.parse(run.metadata_json) as { business_completion_verified?: boolean; external_action_executed?: boolean };
    const step = db.querySql<{ metadata_json: string }>(
      `SELECT metadata_json FROM run_steps WHERE run_id=${db.sqlValue(started.runId)} LIMIT 1`
    )[0];
    const stepMetadata = JSON.parse(step.metadata_json) as { business_completion_verified?: boolean; external_action_executed?: boolean };
    const proof = db.querySql<{ metadata_json: string }>(
      `SELECT metadata_json FROM proofs WHERE run_id=${db.sqlValue(started.runId)} AND proof_type='worker_receipt' LIMIT 1`
    )[0];
    const proofMetadata = JSON.parse(proof.metadata_json) as { business_completion_verified?: boolean; external_action_executed?: boolean };
    assert.equal(run.status, "complete");
    assert.equal(metadata.business_completion_verified, false);
    assert.equal(metadata.external_action_executed, false);
    assert.equal(stepMetadata.business_completion_verified, false);
    assert.equal(stepMetadata.external_action_executed, false);
    assert.equal(proofMetadata.business_completion_verified, false);
    assert.equal(proofMetadata.external_action_executed, false);
  } finally {
    if (previousMode === undefined) delete process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE;
    else process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = previousMode;
    if (previousRunner === undefined) delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER;
    else process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER = previousRunner;
    if (previousEffects === undefined) delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS;
    else process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS = previousEffects;
    if (previousApproval === undefined) delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL;
    else process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL = previousApproval;
  }
});

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const postgresUrl = process.env.AUTOMATION_OS_TEST_POSTGRES_URL;
test("isolated PostgreSQL: expired local claims keep unknown effects and cannot be reclaimed", {
  skip: postgresUrl ? false : "postgres_fixture_unavailable", timeout: 120_000
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "aos-claim-recovery-pg-"));
  process.env.AUTOMATION_OS_DATABASE_URL = postgresUrl;
  process.env.AUTOMATION_OS_ARTIFACT_ROOT = join(root, "artifacts");
  process.env.AUTOMATION_OS_SECRET_DIR = join(root, "secrets");
  process.env.AOS_WEB_OPERATION_BACKEND_CONFIG = join(root, "backend.json");
  process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = "external";
  process.env.AUTOMATION_OS_WORKER_ROLE = "mac";
  process.env.NODE_TEST_CONTEXT = "1";
  const db = await import("../db/client.js");
  await db.initializePostgresSchemaAsync();
  const { startPortableLocalWorkflowRun } = await import("../runs/portableLocalWorkflowEntrypoint.js");
  const { claimPortableMacWorkerAsync } = await import("../runs/portableRemoteWorker.js");
  const companyId = "claim_recovery_pg_company";
  const at = db.nowIso();
  await db.insertAsync("companies", { id: companyId, slug: companyId, name: "Claim recovery fixture", status: "active", created_at: at, updated_at: at });
  for (const mode of ["business_effect", "missing", "read_only", "positive"] as const) {
    const started = await startPortableLocalWorkflowRun({ companyId, workflowId: "obsidian-project-memory-audit",
      sourceTrigger: "automation_os_scheduler", idempotencyKey: `pg-recovery-${mode}` });
    const owner = { companyId, workerId: "mac-pg-claim-owner", workerInstanceId: "mac-pg-original-instance", requestedRunId: started.runId };
    assert.ok(await claimPortableMacWorkerAsync(owner));
    assert.equal(await claimPortableMacWorkerAsync({ ...owner, workerInstanceId: "different-instance" }), null);
    const run = (await db.querySqlAsync<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)}`))[0]!;
    const metadata = JSON.parse(run.metadata_json) as Record<string, unknown>;
    const { execution_mode: _mode, ...originalClaim } = metadata.remote_worker_claim as Record<string, unknown>;
    await db.querySqlAsync(`UPDATE runs SET metadata_json=${db.sqlValue({ ...metadata, external_action_executed: mode === "positive",
      remote_worker_claim: { ...originalClaim, ...(mode === "missing" ? {} : { execution_mode: mode === "positive" ? "business_effect" : mode }),
        lease_expires_at: "2020-01-01T00:00:00.000Z" } })} WHERE id=${db.sqlValue(started.runId)}`);
    assert.equal(await claimPortableMacWorkerAsync({ ...owner, workerId: "mac-pg-next-owner" }), null);
    const terminal = (await db.querySqlAsync<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)}`))[0]!;
    const evidence = JSON.parse(terminal.metadata_json) as Record<string, unknown>;
    assert.equal(terminal.status, "blocked");
    assert.equal(evidence.external_action_executed, mode === "positive" ? true : mode === "read_only" ? false : null);
    assert.equal(evidence.reconciliation_required, mode !== "read_only");
    assert.equal(evidence.operation_effect_state, mode === "read_only" ? "none" : "unknown");
    const events = await db.querySqlAsync<{ metadata_json: string }>(`SELECT metadata_json FROM worker_events WHERE run_id=${db.sqlValue(started.runId)} AND event_type='portable_remote_claim_expired_reconciled'`);
    assert.equal(events.length, 1);
    assert.equal(JSON.parse(events[0].metadata_json).external_action_executed, evidence.external_action_executed);
    assert.equal(await claimPortableMacWorkerAsync(owner), null);
    assert.equal((await db.querySqlAsync<{ count: string }>(`SELECT count(*) AS count FROM proofs WHERE run_id=${db.sqlValue(started.runId)}`))[0].count, "0");
    assert.deepEqual(await db.querySqlAsync(`SELECT id FROM durable_jobs WHERE company_id=${db.sqlValue(companyId)}`), []);
  }
});

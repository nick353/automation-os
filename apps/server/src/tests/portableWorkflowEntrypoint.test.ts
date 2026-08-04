import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-portable-entrypoint-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");
process.env.AUTOMATION_OS_ARTIFACT_ROOT = join(tempRoot, "artifacts");
process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = "canary";

const db = await import("../db/client.js");
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

    const replay = await startPortableWorkflowRun({ ...item, idempotencyKey });
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

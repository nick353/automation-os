import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-daily-ai-completion-reconcile-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");
delete process.env.AUTOMATION_OS_DATABASE_URL;
delete process.env.DATABASE_URL;

const db = await import("../db/client.js");

test("Daily AI completion reconciliation CLI records complete readback without claiming strict runner success", () => {
  db.initDb();
  db.resetDemoData();
  const runDir = join(tempRoot, "daily-ai-complete-run");
  const outDir = join(tempRoot, "completion-reconciliation");
  mkdirSync(runDir, { recursive: true });
  const summaryPath = join(runDir, "registered-playwright-cli-summary.json");
  writeJson(summaryPath, {
    automation_os_run_id: "",
    run_id: "2026-07-02T13-41-45-654Z",
    current_stage: "complete",
    stage_status: "completed",
    stop_reason: "",
    direct_publish: { published: true, posted_count: 2 },
    post_publish_feed_study: { stop_reason: "no_published_rows_for_feed_study", read: 0, external_read: 0 },
    direct_engagement: { sent: 13, receipts: new Array(13).fill({ completion: "like_reflected" }) },
    postflight_sync: { sheets_synced: 459 },
    final_buffer_refresh: { ship_now_buffer_count: 3, usable_publish_candidate_count: 3, ship_now_buffer_target: 3 },
    cleanup_proof: { reason: "completed", owned_process_count: 0 },
    full_flow_completion: {
      ok: true,
      failures: [],
      posted_count: 2,
      engagement_sent_count: 13,
      required_engagement_action_count: 13,
      verified_engagement_action_counts: {
        x: { like_candidate: 5, comment_candidate: 2 },
        linkedin: { like_candidate: 5, comment_candidate: 1 }
      },
      missing_verified_engagement_targets: [],
      required_engagement_platforms: ["x", "linkedin"],
      verified_engagement_platforms: ["linkedin", "x"],
      missing_required_engagement_platforms: [],
      verified_external_engagement_targets_complete: true,
      verified_engagement_covers_no_published_feed_study: true,
      sheets_synced_count: 459,
      feed_study_count: 0,
      external_posts_read: 0,
      feed_study_stop_reason: "no_published_rows_for_feed_study",
      ship_now_buffer_count: 3,
      usable_publish_candidate_count: 3,
      ship_now_buffer_target: 3,
      buffer_replenish_completed: true,
      visual_audit_failures: []
    }
  });

  const now = db.nowIso();
  db.insert("runs", {
    id: "run_mqtbe1ef_p0tjpw",
    name: "Daily AI registered workflow historical blocker",
    status: "blocked",
    objective: "historical blocked Daily AI run",
    created_at: now,
    updated_at: now,
    metadata_json: {
      registeredWorkflowId: "daily-ai-research-publish-run",
      registered_workflow_id: "daily-ai-research-publish-run",
      proof_gate: { ok: false, missing: ["daily_ai_buffer"], present: ["daily_ai_sync"] }
    }
  });
  db.insert("runs", {
    id: "run_daily_ai_partial_ingest_existing",
    name: "Existing Daily AI partial ingest readback",
    status: "partial",
    objective: "existing reconciliation run that must not become the source run",
    created_at: db.nowIso(),
    updated_at: db.nowIso(),
    metadata_json: {
      registeredWorkflowId: "daily-ai-research-publish-run",
      registered_workflow_id: "daily-ai-research-publish-run",
      reconciliation_run: true,
      reconciliation_of_run_id: "run_mqtbe1ef_p0tjpw"
    }
  });

  const output = execFileSync(
    process.execPath,
    ["apps/server/dist/cli/reconcileDailyAiCompletion.js", `--summary=${summaryPath}`, `--out-dir=${outDir}`, "--commit"],
    {
      cwd: process.cwd(),
      env: { ...process.env, AUTOMATION_OS_DB: process.env.AUTOMATION_OS_DB ?? "" },
      encoding: "utf8"
    }
  );
  const body = JSON.parse(output) as { ok: boolean; committedRun: { runId: string; proofId: string } | null; receiptPath: string };
  assert.equal(body.ok, true);
  assert.ok(body.committedRun?.runId);
  assert.ok(body.committedRun?.proofId);

  const receipt = JSON.parse(readFileSync(body.receiptPath, "utf8")) as {
    automation_os_db_mutated: boolean;
    strict_registered_success_claimed: boolean;
    project_run: {
      automation_os_run_id: string;
      external_actions_performed: boolean;
      additional_posts_published: boolean;
      proof_gate: { ok: boolean; missing: string[]; present: string[] };
      posted_count: number;
      engagement_sent_count: number;
      sheets_synced_count: number;
    };
  };
  assert.equal(receipt.automation_os_db_mutated, true);
  assert.equal(receipt.strict_registered_success_claimed, false);
  assert.equal(receipt.project_run.automation_os_run_id, "");
  assert.equal(receipt.project_run.external_actions_performed, false);
  assert.equal(receipt.project_run.additional_posts_published, false);
  assert.equal(receipt.project_run.proof_gate.ok, true);
  assert.deepEqual(receipt.project_run.proof_gate.missing, []);
  assert.ok(receipt.project_run.proof_gate.present.includes("daily_ai_completion_reconciliation_readback"));
  assert.equal(receipt.project_run.posted_count, 2);
  assert.equal(receipt.project_run.engagement_sent_count, 13);
  assert.equal(receipt.project_run.sheets_synced_count, 459);

  const sourceRun = db.querySql<{ status: string }>("SELECT status FROM runs WHERE id='run_mqtbe1ef_p0tjpw'")[0];
  assert.equal(sourceRun.status, "blocked");
  const newRun = db.querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id='${body.committedRun.runId}'`)[0];
  assert.equal(newRun.status, "complete");
  const metadata = JSON.parse(newRun.metadata_json) as {
    reconciliation_of_run_id: string;
    reconciliation_kind: string;
    external_actions_performed: boolean;
    additional_posts_published: boolean;
    strict_registered_success_claimed: boolean;
    proof_gate: { ok: boolean; missing: string[]; present: string[] };
  };
  assert.equal(metadata.reconciliation_of_run_id, "run_mqtbe1ef_p0tjpw");
  assert.equal(metadata.reconciliation_kind, "daily_ai_completion");
  assert.equal(metadata.external_actions_performed, false);
  assert.equal(metadata.additional_posts_published, false);
  assert.equal(metadata.strict_registered_success_claimed, false);
  assert.equal(metadata.proof_gate.ok, true);
  assert.deepEqual(metadata.proof_gate.missing, []);
  assert.ok(metadata.proof_gate.present.includes("daily_ai_completion_reconciliation_readback"));
  const step = db.querySql<{ status: string }>(`SELECT status FROM run_steps WHERE run_id='${body.committedRun.runId}'`)[0];
  assert.equal(step.status, "completed");
  const proof = db.querySql<{ proof_type: string; uri: string }>(`SELECT proof_type, uri FROM proofs WHERE id='${body.committedRun.proofId}'`)[0];
  assert.equal(proof.proof_type, "daily_ai_completion_reconciliation_readback");
  assert.match(proof.uri, /daily-ai-completion-reconciliation-receipt\.json$/);
  const event = db.querySql<{ event_type: string }>(`SELECT event_type FROM worker_events WHERE run_id='${body.committedRun.runId}'`)[0];
  assert.equal(event.event_type, "worker_completed");
});

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

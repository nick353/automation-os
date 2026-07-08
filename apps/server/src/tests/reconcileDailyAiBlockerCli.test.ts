import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-daily-ai-reconcile-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");
delete process.env.AUTOMATION_OS_DATABASE_URL;
delete process.env.DATABASE_URL;

const db = await import("../db/client.js");

test("Daily AI blocker reconciliation CLI records a blocked readback without posting or mutating the source run", () => {
  db.initDb();
  db.resetDemoData();
  const runDir = join(tempRoot, "daily-ai-run");
  const outDir = join(tempRoot, "reconciliation");
  mkdirSync(runDir, { recursive: true });
  const summaryPath = join(runDir, "registered-playwright-cli-summary.json");
  writeJson(summaryPath, {
    run_id: "run_mr0bb2w6_hjorkr",
    direct_publish: null,
    post_publish_feed_study: null,
    direct_engagement: null,
    postflight_sync: { sheets_synced: 446 },
    final_buffer_refresh: { ship_now_buffer_count: 1, usable_publish_candidate_count: 1, ship_now_buffer_target: 3 },
    cleanup_proof: { owned_process_count: 0 },
    full_flow_completion: {
      ok: false,
      posted_count: 0,
      engagement_sent_count: 0,
      sheets_synced_count: 446,
      feed_study_count: 0,
      ship_now_buffer_count: 1,
      usable_publish_candidate_count: 1,
      ship_now_buffer_target: 3,
      runway_mcp_repair: {
        required: true,
        exact_blocker:
          "runway_mcp_repair_required:image_generation_unavailable: runway_mcp_result_handoff_missing. Set DAILY_AI_RUNWAY_MCP_RESULT to a current Daily AI Runway MCP result JSON from an already-authorized client"
      },
      failures: [
        "publish_completion_missing",
        "runway_mcp_repair_required:image_generation_unavailable: runway_mcp_result_handoff_missing",
        "full_flow_incomplete"
      ]
    }
  });

  const now = db.nowIso();
  db.insert("runs", {
    id: "run_mqtbe1ef_p0tjpw",
    name: "Daily AI registered workflow stale blocker",
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
    id: "run_daily_ai_reconcile_existing",
    name: "Existing Daily AI blocker reconciliation readback",
    status: "blocked",
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
    ["apps/server/dist/cli/reconcileDailyAiBlocker.js", `--summary=${summaryPath}`, `--out-dir=${outDir}`, "--commit"],
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
      external_actions_performed: boolean;
      additional_posts_published: boolean;
      proof_gate: { ok: boolean; missing: string[] };
    };
  };
  assert.equal(receipt.automation_os_db_mutated, true);
  assert.equal(receipt.strict_registered_success_claimed, false);
  assert.equal(receipt.project_run.external_actions_performed, false);
  assert.equal(receipt.project_run.additional_posts_published, false);
  assert.equal(receipt.project_run.proof_gate.ok, false);
  assert.ok(receipt.project_run.proof_gate.missing.includes("runway_mcp_repair_required"));
  assert.ok(receipt.project_run.proof_gate.missing.includes("daily_ai_buffer"));

  const sourceRun = db.querySql<{ status: string }>("SELECT status FROM runs WHERE id='run_mqtbe1ef_p0tjpw'")[0];
  assert.equal(sourceRun.status, "blocked");
  const newRun = db.querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id='${body.committedRun.runId}'`)[0];
  assert.equal(newRun.status, "blocked");
  const metadata = JSON.parse(newRun.metadata_json) as {
    reconciliation_of_run_id: string;
    additional_posts_published: boolean;
    external_actions_performed: boolean;
    strict_registered_success_claimed: boolean;
    proof_gate: { ok: boolean; missing: string[] };
  };
  assert.equal(metadata.reconciliation_of_run_id, "run_mqtbe1ef_p0tjpw");
  assert.equal(metadata.additional_posts_published, false);
  assert.equal(metadata.external_actions_performed, false);
  assert.equal(metadata.strict_registered_success_claimed, false);
  assert.equal(metadata.proof_gate.ok, false);
  assert.ok(metadata.proof_gate.missing.includes("runway_mcp_repair_required"));
  const proof = db.querySql<{ proof_type: string; uri: string }>(`SELECT proof_type, uri FROM proofs WHERE id='${body.committedRun.proofId}'`)[0];
  assert.equal(proof.proof_type, "daily_ai_blocker_reconciliation_readback");
  assert.match(proof.uri, /daily-ai-blocker-reconciliation-receipt\.json$/);
  const event = db.querySql<{ event_type: string }>(`SELECT event_type FROM worker_events WHERE run_id='${body.committedRun.runId}'`)[0];
  assert.equal(event.event_type, "worker_blocked");
});

test("Daily AI blocker reconciliation CLI records fresh child partial ingest without resuming external actions", () => {
  db.initDb();
  db.resetDemoData();
  const ingestDir = join(tempRoot, "daily-ai-ingest");
  const outDir = join(tempRoot, "partial-ingest-reconciliation");
  mkdirSync(ingestDir, { recursive: true });
  const ingestReceiptPath = join(ingestDir, "daily-ai-fresh-child-ingest-readback.json");
  writeJson(ingestReceiptPath, {
    ok: true,
    workflow: "daily-ai-research-publish-run",
    stage: "fresh_registered_child_ingest_readback",
    child_thread_id: "019f22a8-1b8a-70a3-bb7b-c502920945b2",
    child_status: "idle_after_interruption",
    run_summary: "/Users/nichikatanaka/Documents/New project/artifacts/playwright-cli-runs/2026-07-02T11-51-11-482Z/registered-playwright-cli-summary.json",
    run_id: "2026-07-02T11-51-11-482Z",
    strict_registered_success_claimed: false,
    automation_os_db_mutated: false,
    parent_external_action_performed: false,
    child_external_action_observed: true,
    external_action_summary: {
      row_id: "2026-04-29-openai-cybersecurity-intelligence-age",
      platform: "linkedin",
      linkedin_post_url: "https://www.linkedin.com/feed/update/urn:li:activity:7478415324938399744/",
      x_post_url_preserved: "https://x.com/nichika2000823/status/2070298225282789489",
      x_reposted: false
    },
    terminal_state: {
      current_stage: "replenish_ship_now_buffer_2",
      stage_status: "aborted",
      full_flow_ok: false,
      failures: ["signal:SIGTERM"],
      posted_count: 1,
      engagement_sent_count: 0,
      sheets_synced_count: 446,
      feed_study_count: 0
    },
    queue_readback: {
      buffer_after_stop: {
        ship_now_buffer_count: 2,
        usable_publish_candidate_count: 2,
        candidate_ids: ["2b6976f96bb5", "2026-04-21-openai-scaling-codex-enterprises"]
      }
    },
    remaining_blocker:
      "user_interrupted_after_linkedin_publish:signal_SIGTERM; post_publish_feed_study_missing; engagement_not_completed; ship_now_buffer_below_target:2/3; cleanup_incomplete_or_interrupted_summary"
  });

  const now = db.nowIso();
  db.insert("runs", {
    id: "run_daily_ai_reconcile_mr3e7n0o_l5woaj",
    name: "Daily AI blocker reconciliation readback",
    status: "blocked",
    objective: "previous reconciliation run",
    created_at: now,
    updated_at: now,
    metadata_json: {
      registeredWorkflowId: "daily-ai-research-publish-run",
      registered_workflow_id: "daily-ai-research-publish-run",
      reconciliation_run: true
    }
  });
  db.insert("runs", {
    id: "run_mqtbe1ef_p0tjpw",
    name: "Daily AI registered workflow stale blocker",
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

  const output = execFileSync(
    process.execPath,
    ["apps/server/dist/cli/reconcileDailyAiBlocker.js", `--ingest-receipt=${ingestReceiptPath}`, `--out-dir=${outDir}`, "--commit"],
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
      parent_external_action_performed: boolean;
      child_external_action_observed: boolean;
      external_actions_performed: boolean;
      additional_posts_published: boolean;
      exact_blocker: string;
      proof_gate: { ok: boolean; missing: string[] };
      external_action_summary: { linkedin_post_url: string; x_reposted: boolean };
    };
  };
  assert.equal(receipt.automation_os_db_mutated, true);
  assert.equal(receipt.strict_registered_success_claimed, false);
  assert.equal(receipt.project_run.parent_external_action_performed, false);
  assert.equal(receipt.project_run.child_external_action_observed, true);
  assert.equal(receipt.project_run.external_actions_performed, false);
  assert.equal(receipt.project_run.additional_posts_published, false);
  assert.equal(receipt.project_run.external_action_summary.x_reposted, false);
  assert.match(receipt.project_run.external_action_summary.linkedin_post_url, /linkedin\.com/);
  assert.match(receipt.project_run.exact_blocker, /user_interrupted_after_linkedin_publish/);
  assert.equal(receipt.project_run.proof_gate.ok, false);
  assert.ok(receipt.project_run.proof_gate.missing.includes("daily_ai_buffer"));
  assert.ok(!receipt.project_run.proof_gate.missing.includes("daily_ai_sync"));

  const sourceRun = db.querySql<{ status: string }>("SELECT status FROM runs WHERE id='run_mqtbe1ef_p0tjpw'")[0];
  assert.equal(sourceRun.status, "blocked");
  const newRun = db.querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id='${body.committedRun.runId}'`)[0];
  assert.equal(newRun.status, "partial");
  const metadata = JSON.parse(newRun.metadata_json) as {
    reconciliation_of_run_id: string;
    reconciliation_kind: string;
    parent_external_action_performed: boolean;
    child_external_action_observed: boolean;
    additional_posts_published: boolean;
    external_actions_performed: boolean;
    strict_registered_success_claimed: boolean;
    external_action_summary: { linkedin_post_url: string; x_reposted: boolean };
    proof_gate: { ok: boolean; missing: string[] };
  };
  assert.equal(metadata.reconciliation_of_run_id, "run_mqtbe1ef_p0tjpw");
  assert.equal(metadata.reconciliation_kind, "fresh_child_partial_ingest");
  assert.equal(metadata.parent_external_action_performed, false);
  assert.equal(metadata.child_external_action_observed, true);
  assert.equal(metadata.additional_posts_published, false);
  assert.equal(metadata.external_actions_performed, false);
  assert.equal(metadata.strict_registered_success_claimed, false);
  assert.equal(metadata.external_action_summary.x_reposted, false);
  assert.ok(metadata.proof_gate.missing.includes("daily_ai_engagement"));
  assert.ok(!metadata.proof_gate.missing.includes("daily_ai_sync"));
  const proof = db.querySql<{ proof_type: string; uri: string }>(`SELECT proof_type, uri FROM proofs WHERE id='${body.committedRun.proofId}'`)[0];
  assert.equal(proof.proof_type, "daily_ai_fresh_child_partial_ingest_readback");
  assert.match(proof.uri, /daily-ai-fresh-child-partial-ingest-reconciliation-receipt\.json$/);
  const event = db.querySql<{ event_type: string }>(`SELECT event_type FROM worker_events WHERE run_id='${body.committedRun.runId}'`)[0];
  assert.equal(event.event_type, "worker_blocked");
});

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-prompt-transfer-reconcile-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");
delete process.env.AUTOMATION_OS_DATABASE_URL;
delete process.env.DATABASE_URL;

const db = await import("../db/client.js");

test("Prompt Transfer blocker reconciliation records google service account blocker without Sheets writes", () => {
  db.initDb();
  db.resetDemoData();
  const runDir = join(tempRoot, "prompt-transfer-run");
  const applyPlanDir = join(runDir, "apply-plan");
  const outDir = join(tempRoot, "reconciliation");
  mkdirSync(applyPlanDir, { recursive: true });
  const summaryPath = join(runDir, "result.json");
  writeJson(summaryPath, {
    status: "blocked",
    run_id: "run_mqtbe1ep_vgi2ex",
    source_url: "https://docs.google.com/document/d/source/edit",
    target_url: "https://docs.google.com/spreadsheets/d/target/edit",
    theme: "浮世絵 猫シリーズ",
    commit_requested: true,
    allow_external_commit: true,
    committed: false,
    artifact_uri: runDir,
    stages: [
      { stage: "extract", status: "success", artifact_uri: join(runDir, "extract", "extracted.json") },
      { stage: "apply-plan", status: "success", artifact_uri: join(applyPlanDir, "plan.json") }
    ],
    exact_blocker: "google_service_account_json_missing",
    retry_from_stage: "commit"
  });
  writeJson(join(applyPlanDir, "plan.json"), {
    status: "ready",
    target_url: "https://docs.google.com/spreadsheets/d/target/edit",
    theme: "浮世絵 猫シリーズ",
    prompt_text: "Japanese woodblock print style...",
    adopted: "○",
    rows: [{ row: 16, theme_cell: "B16", prompt_cell: "C16", adopted_cell: "D16" }],
    append_row: 16
  });

  const now = db.nowIso();
  db.insert("runs", {
    id: "run_mqtbe1ep_vgi2ex",
    name: "Prompt Transfer Ukiyoe registered workflow billing-only save sheets",
    status: "blocked",
    objective: "historical Prompt Transfer credential blocker",
    created_at: now,
    updated_at: now,
    metadata_json: {
      registeredWorkflowId: "prompt-transfer-ukiyoe",
      registered_workflow_id: "prompt-transfer-ukiyoe",
      exact_blocker: "google_service_account_json_missing",
      proof_gate: { ok: false, missing: ["prompt_transfer_runner_exit_nonzero"], present: [] }
    }
  });
  db.insert("runs", {
    id: "run_prompt_transfer_reconcile_existing",
    name: "Existing Prompt Transfer blocker reconciliation readback",
    status: "blocked",
    objective: "existing reconciliation run that must not become the source run",
    created_at: db.nowIso(),
    updated_at: db.nowIso(),
    metadata_json: {
      registeredWorkflowId: "prompt-transfer-ukiyoe",
      registered_workflow_id: "prompt-transfer-ukiyoe",
      reconciliation_run: true,
      reconciliation_of_run_id: "run_mqtbe1ep_vgi2ex"
    }
  });

  const output = execFileSync(
    process.execPath,
    ["apps/server/dist/cli/reconcilePromptTransferBlocker.js", `--summary=${summaryPath}`, `--out-dir=${outDir}`, "--commit"],
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
      exact_blocker: string;
      planned_range: string;
      committed: boolean;
      external_actions_performed: boolean;
      google_sheets_write_performed: boolean;
      proof_gate: { ok: boolean; missing: string[]; present: string[] };
    };
  };
  assert.equal(receipt.automation_os_db_mutated, true);
  assert.equal(receipt.strict_registered_success_claimed, false);
  assert.equal(receipt.project_run.exact_blocker, "google_service_account_json_missing");
  assert.equal(receipt.project_run.planned_range, "B16:D16");
  assert.equal(receipt.project_run.committed, false);
  assert.equal(receipt.project_run.external_actions_performed, false);
  assert.equal(receipt.project_run.google_sheets_write_performed, false);
  assert.equal(receipt.project_run.proof_gate.ok, false);
  assert.deepEqual(receipt.project_run.proof_gate.missing, ["google_service_account_json_missing"]);
  assert.ok(receipt.project_run.proof_gate.present.includes("prompt_transfer_plan_ready"));
  assert.ok(receipt.project_run.proof_gate.present.includes("prompt_transfer_blocker_reconciliation_readback"));

  const sourceRun = db.querySql<{ status: string }>("SELECT status FROM runs WHERE id='run_mqtbe1ep_vgi2ex'")[0];
  assert.equal(sourceRun.status, "blocked");
  const newRun = db.querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id='${body.committedRun.runId}'`)[0];
  const step = db.querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM run_steps WHERE run_id='${body.committedRun.runId}' LIMIT 1`)[0];
  assert.equal(newRun.status, "blocked");
  assert.equal(step.status, "blocked");
  const metadata = JSON.parse(newRun.metadata_json) as {
    reconciliation_of_run_id: string;
    exact_blocker: string;
    committed: boolean;
    google_sheets_write_performed: boolean;
    external_actions_performed: boolean;
    strict_registered_success_claimed: boolean;
    proof_gate: { ok: boolean; missing: string[] };
    planned_range: string;
    route_decision?: { fingerprint?: string; phase?: string };
    route_decision_fingerprint?: string | null;
    route_readback?: null;
    execution_routing?: { fingerprint?: string };
  };
  const stepMetadata = JSON.parse(step.metadata_json) as {
    route_decision?: { fingerprint?: string; phase?: string };
    route_decision_fingerprint?: string | null;
    route_readback?: null;
    execution_routing?: { fingerprint?: string };
  };
  assert.equal(metadata.reconciliation_of_run_id, "run_mqtbe1ep_vgi2ex");
  assert.equal(metadata.exact_blocker, "google_service_account_json_missing");
  assert.equal(metadata.committed, false);
  assert.equal(metadata.google_sheets_write_performed, false);
  assert.equal(metadata.external_actions_performed, false);
  assert.equal(metadata.strict_registered_success_claimed, false);
  assert.equal(metadata.proof_gate.ok, false);
  assert.deepEqual(metadata.proof_gate.missing, ["google_service_account_json_missing"]);
  assert.equal(metadata.planned_range, "B16:D16");
  assert.equal(metadata.route_decision?.phase, "route_decision");
  assert.equal(metadata.route_decision_fingerprint, metadata.route_decision?.fingerprint ?? null);
  assert.equal(metadata.execution_routing?.fingerprint, metadata.route_decision?.fingerprint);
  assert.equal(metadata.route_readback, null);
  assert.equal(stepMetadata.route_decision?.phase, "route_decision");
  assert.equal(stepMetadata.route_decision_fingerprint, metadata.route_decision?.fingerprint ?? null);
  assert.equal(stepMetadata.execution_routing?.fingerprint, metadata.route_decision?.fingerprint);
  assert.equal(stepMetadata.route_readback, null);
  const proof = db.querySql<{ proof_type: string; uri: string }>(`SELECT proof_type, uri FROM proofs WHERE id='${body.committedRun.proofId}'`)[0];
  assert.equal(proof.proof_type, "prompt_transfer_blocker_reconciliation_readback");
  assert.match(proof.uri, /prompt-transfer-blocker-reconciliation-receipt\.json$/);
  const event = db.querySql<{ event_type: string }>(`SELECT event_type FROM worker_events WHERE run_id='${body.committedRun.runId}'`)[0];
  assert.equal(event.event_type, "worker_blocked");
});

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

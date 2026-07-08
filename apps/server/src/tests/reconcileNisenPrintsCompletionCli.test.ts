import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-nisenprints-reconcile-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");
delete process.env.AUTOMATION_OS_DATABASE_URL;
delete process.env.DATABASE_URL;

const db = await import("../db/client.js");

test("NisenPrints reconciliation CLI records partial readback without changing the blocked source run", () => {
  db.initDb();
  db.resetDemoData();
  const fixtureDir = join(tempRoot, "nisenprints");
  const outDir = join(tempRoot, "reconciliation");
  mkdirSync(fixtureDir, { recursive: true });
  const manifestPath = join(fixtureDir, "publish-manifest.json");
  const strictProofPath = join(fixtureDir, "strict-completion-public-proof.json");
  writeJson(manifestPath, {
    ok: true,
    run_id: "2026-06-25-210709-ce8b-fuji-hollyhock-summer-onsen-torbie-cat",
    final_status: "pinterest_posted",
    blocker: "",
    replacement_asset_source_path: "/tmp/final-art.png",
    printify_product_id: "6a3e124c8b3f02d155080dbc",
    etsy_listing_id: "4528244402",
    etsy_listing_url: "https://www.etsy.com/listing/4528244402/fuji-hollyhock-summer-onsen-cat-wall-art",
    pinterest_pin_url: "https://www.pinterest.com/pin/982347737607048291"
  });
  writeJson(strictProofPath, {
    ok: true,
    completion_ok: true,
    classification: "public_local_complete_stage_observation_incomplete",
    strict_stage_observations_ok: false,
    strict_stage_observation_missing: ["printify_publish/attempt-1/network.jsonl"],
    etsy_listing_id: "4528244402",
    etsy_listing_url: "https://www.etsy.com/listing/4528244402/fuji-hollyhock-summer-onsen-cat-wall-art",
    pinterest_pin_url: "https://www.pinterest.com/pin/982347737607048291",
    link: "https://www.etsy.com/listing/4528244402/fuji-hollyhock-summer-onsen-cat-wall-art"
  });

  const now = db.nowIso();
  db.insert("runs", {
    id: "run_mqtbe1en_dvqg94",
    name: "NisenPrints registered workflow billing-only proof gate full publish",
    status: "blocked",
    objective: "historical blocked NisenPrints run",
    created_at: now,
    updated_at: now,
    metadata_json: {
      registeredWorkflowId: "nisenprints-daily-product-canva-printify-etsy-pinterest",
      registered_workflow_id: "nisenprints-daily-product-canva-printify-etsy-pinterest",
      proof_gate: {
        ok: false,
        missing: ["generation_manifest_verified", "etsy_listing_published", "pinterest_pin_url_verified", "etsy_visit_site_match_verified", "nisenprints_runner_exit_0"],
        present: ["nisenprints_registered_summary"]
      }
    }
  });
  db.insert("runs", {
    id: "run_nisenprints_reconcile_existing",
    name: "Existing NisenPrints reconciliation readback",
    status: "partial",
    objective: "existing reconciliation run that must not become the source run",
    created_at: db.nowIso(),
    updated_at: db.nowIso(),
    metadata_json: {
      registeredWorkflowId: "nisenprints-daily-product-canva-printify-etsy-pinterest",
      registered_workflow_id: "nisenprints-daily-product-canva-printify-etsy-pinterest",
      reconciliation_run: true,
      reconciliation_of_run_id: "run_mqtbe1en_dvqg94"
    }
  });

  const output = execFileSync(
    process.execPath,
    ["apps/server/dist/cli/reconcileNisenPrintsCompletion.js", `--manifest=${manifestPath}`, `--strict-proof=${strictProofPath}`, `--out-dir=${outDir}`, "--commit"],
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
    strict_registered_success_claimed: boolean;
    accepted_partial: boolean;
    accepted_partial_reason: string;
    project_run: {
      public_local_completion_observed: boolean;
      strict_stage_observations_ok: boolean;
      artifact_identity_consistent: boolean;
      accepted_partial: boolean;
      accepted_partial_reason: string;
      proof_gate: { ok: boolean; missing: string[]; present: string[] };
      external_actions_performed: boolean;
      additional_listing_created: boolean;
      additional_pin_created: boolean;
    };
  };
  assert.equal(receipt.strict_registered_success_claimed, false);
  assert.equal(receipt.accepted_partial, true);
  assert.equal(receipt.accepted_partial_reason, "historical_strict_runner_proof_gap");
  assert.equal(receipt.project_run.public_local_completion_observed, true);
  assert.equal(receipt.project_run.strict_stage_observations_ok, false);
  assert.equal(receipt.project_run.artifact_identity_consistent, true);
  assert.equal(receipt.project_run.accepted_partial, true);
  assert.equal(receipt.project_run.accepted_partial_reason, "historical_strict_runner_proof_gap");
  assert.equal(receipt.project_run.proof_gate.ok, false);
  assert.ok(receipt.project_run.proof_gate.present.includes("generation_manifest_verified"));
  assert.ok(receipt.project_run.proof_gate.present.includes("etsy_listing_published"));
  assert.ok(receipt.project_run.proof_gate.present.includes("pinterest_pin_url_verified"));
  assert.ok(receipt.project_run.proof_gate.present.includes("etsy_visit_site_match_verified"));
  assert.ok(receipt.project_run.proof_gate.missing.includes("nisenprints_runner_exit_0"));
  assert.ok(receipt.project_run.proof_gate.missing.includes("strict_stage_observation:printify_publish/attempt-1/network.jsonl"));
  assert.equal(receipt.project_run.external_actions_performed, false);
  assert.equal(receipt.project_run.additional_listing_created, false);
  assert.equal(receipt.project_run.additional_pin_created, false);

  const sourceRun = db.querySql<{ status: string }>("SELECT status FROM runs WHERE id='run_mqtbe1en_dvqg94'")[0];
  assert.equal(sourceRun.status, "blocked");
  const newRun = db.querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id='${body.committedRun.runId}'`)[0];
  assert.equal(newRun.status, "partial");
  const metadata = JSON.parse(newRun.metadata_json) as {
    reconciliation_of_run_id: string;
    strict_registered_success_claimed: boolean;
    public_local_completion_observed: boolean;
    strict_stage_observations_ok: boolean;
    artifact_identity_consistent: boolean;
    accepted_partial: boolean;
    accepted_partial_reason: string;
    proof_gate: { ok: boolean; missing: string[] };
  };
  assert.equal(metadata.reconciliation_of_run_id, "run_mqtbe1en_dvqg94");
  assert.equal(metadata.strict_registered_success_claimed, false);
  assert.equal(metadata.public_local_completion_observed, true);
  assert.equal(metadata.strict_stage_observations_ok, false);
  assert.equal(metadata.artifact_identity_consistent, true);
  assert.equal(metadata.accepted_partial, true);
  assert.equal(metadata.accepted_partial_reason, "historical_strict_runner_proof_gap");
  assert.equal(metadata.proof_gate.ok, false);
  assert.ok(metadata.proof_gate.missing.includes("nisenprints_runner_exit_0"));
  const proof = db.querySql<{ proof_type: string; uri: string }>(`SELECT proof_type, uri FROM proofs WHERE id='${body.committedRun.proofId}'`)[0];
  assert.equal(proof.proof_type, "nisenprints_completion_reconciliation_readback");
  assert.match(proof.uri, /nisenprints-completion-reconciliation-receipt\.json$/);
  const event = db.querySql<{ event_type: string }>(`SELECT event_type FROM worker_events WHERE run_id='${body.committedRun.runId}'`)[0];
  assert.equal(event.event_type, "worker_blocked");
});

test("NisenPrints reconciliation keeps proof gate partial when strict stage evidence exists but runner exit is unavailable", () => {
  db.initDb();
  db.resetDemoData();
  const fixtureDir = join(tempRoot, "nisenprints-strict-stage-ok");
  const outDir = join(tempRoot, "reconciliation-strict-stage-ok");
  mkdirSync(fixtureDir, { recursive: true });
  const manifestPath = join(fixtureDir, "publish-manifest.json");
  const strictProofPath = join(fixtureDir, "strict-completion-public-proof.json");
  writeJson(manifestPath, {
    ok: true,
    run_id: "2026-06-25-210709-ce8b-fuji-hollyhock-summer-onsen-torbie-cat",
    final_status: "pinterest_posted",
    replacement_asset_source_path: "/tmp/final-art.png",
    printify_product_id: "6a3e124c8b3f02d155080dbc",
    etsy_listing_id: "4528244402",
    etsy_listing_url: "https://www.etsy.com/listing/4528244402/fuji-hollyhock-summer-onsen-cat-wall-art",
    pinterest_pin_url: "https://www.pinterest.com/pin/982347737607048291"
  });
  writeJson(strictProofPath, {
    ok: true,
    completion_ok: true,
    classification: "public_local_complete",
    strict_stage_observations_ok: true,
    etsy_listing_url: "https://www.etsy.com/listing/4528244402/fuji-hollyhock-summer-onsen-cat-wall-art",
    pinterest_pin_url: "https://www.pinterest.com/pin/982347737607048291",
    link: "https://www.etsy.com/listing/4528244402/fuji-hollyhock-summer-onsen-cat-wall-art"
  });

  const now = db.nowIso();
  db.insert("runs", {
    id: "run_mqtbe1en_dvqg94",
    name: "NisenPrints registered workflow billing-only proof gate full publish",
    status: "blocked",
    objective: "historical blocked NisenPrints run",
    created_at: now,
    updated_at: now,
    metadata_json: {
      registeredWorkflowId: "nisenprints-daily-product-canva-printify-etsy-pinterest",
      registered_workflow_id: "nisenprints-daily-product-canva-printify-etsy-pinterest"
    }
  });

  const output = execFileSync(
    process.execPath,
    ["apps/server/dist/cli/reconcileNisenPrintsCompletion.js", `--manifest=${manifestPath}`, `--strict-proof=${strictProofPath}`, `--out-dir=${outDir}`, "--commit"],
    {
      cwd: process.cwd(),
      env: { ...process.env, AUTOMATION_OS_DB: process.env.AUTOMATION_OS_DB ?? "" },
      encoding: "utf8"
    }
  );
  const body = JSON.parse(output) as { ok: boolean; committedRun: { runId: string; proofId: string } | null; receiptPath: string };
  assert.equal(body.ok, true);
  assert.ok(body.committedRun?.runId);

  const receipt = JSON.parse(readFileSync(body.receiptPath, "utf8")) as {
    strict_registered_success_claimed: boolean;
    accepted_partial: boolean;
    accepted_partial_reason: string;
    reconciliation_status: string;
    project_run: {
      strict_stage_observations_ok: boolean;
      accepted_partial: boolean;
      accepted_partial_reason: string;
      proof_gate: { ok: boolean; missing: string[] };
    };
  };
  assert.equal(receipt.strict_registered_success_claimed, false);
  assert.equal(receipt.accepted_partial, true);
  assert.equal(receipt.accepted_partial_reason, "historical_runner_exit_proof_gap");
  assert.equal(receipt.reconciliation_status, "project_owned_completion_observed_but_registered_runner_success_not_claimed");
  assert.equal(receipt.project_run.strict_stage_observations_ok, true);
  assert.equal(receipt.project_run.accepted_partial, true);
  assert.equal(receipt.project_run.accepted_partial_reason, "historical_runner_exit_proof_gap");
  assert.equal(receipt.project_run.proof_gate.ok, false);
  assert.deepEqual(receipt.project_run.proof_gate.missing, ["nisenprints_runner_exit_0"]);

  const newRun = db.querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id='${body.committedRun.runId}'`)[0];
  assert.equal(newRun.status, "partial");
  const metadata = JSON.parse(newRun.metadata_json) as {
    strict_registered_success_claimed: boolean;
    accepted_partial: boolean;
    accepted_partial_reason: string;
    proof_gate: { ok: boolean; missing: string[] };
  };
  assert.equal(metadata.strict_registered_success_claimed, false);
  assert.equal(metadata.accepted_partial, true);
  assert.equal(metadata.accepted_partial_reason, "historical_runner_exit_proof_gap");
  assert.equal(metadata.proof_gate.ok, false);
  assert.deepEqual(metadata.proof_gate.missing, ["nisenprints_runner_exit_0"]);
});

test("NisenPrints reconciliation rejects mismatched manifest and strict proof identity", () => {
  db.initDb();
  db.resetDemoData();
  const fixtureDir = join(tempRoot, "nisenprints-mismatched-identity");
  const outDir = join(tempRoot, "reconciliation-mismatched-identity");
  mkdirSync(fixtureDir, { recursive: true });
  const manifestPath = join(fixtureDir, "publish-manifest.json");
  const strictProofPath = join(fixtureDir, "strict-completion-public-proof.json");
  writeJson(manifestPath, {
    ok: true,
    run_id: "2026-06-25-210709-ce8b-fuji-hollyhock-summer-onsen-torbie-cat",
    final_status: "pinterest_posted",
    replacement_asset_source_path: "/tmp/final-art.png",
    printify_product_id: "6a3e124c8b3f02d155080dbc",
    etsy_listing_id: "4528244402",
    etsy_listing_url: "https://www.etsy.com/listing/4528244402/fuji-hollyhock-summer-onsen-cat-wall-art",
    pinterest_pin_url: "https://www.pinterest.com/pin/982347737607048291"
  });
  writeJson(strictProofPath, {
    ok: true,
    completion_ok: true,
    classification: "public_local_complete_stage_observation_incomplete",
    strict_stage_observations_ok: false,
    strict_stage_observation_missing: ["printify_publish/attempt-1/network.jsonl"],
    etsy_listing_id: "9999999999",
    etsy_listing_url: "https://www.etsy.com/listing/9999999999/wrong-listing",
    pinterest_pin_url: "https://www.pinterest.com/pin/111111111111111111"
  });

  const now = db.nowIso();
  db.insert("runs", {
    id: "run_mqtbe1en_dvqg94",
    name: "NisenPrints registered workflow billing-only proof gate full publish",
    status: "blocked",
    objective: "historical blocked NisenPrints run",
    created_at: now,
    updated_at: now,
    metadata_json: {
      registeredWorkflowId: "nisenprints-daily-product-canva-printify-etsy-pinterest",
      registered_workflow_id: "nisenprints-daily-product-canva-printify-etsy-pinterest"
    }
  });

  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        ["apps/server/dist/cli/reconcileNisenPrintsCompletion.js", `--manifest=${manifestPath}`, `--strict-proof=${strictProofPath}`, `--out-dir=${outDir}`, "--commit"],
        {
          cwd: process.cwd(),
          env: { ...process.env, AUTOMATION_OS_DB: process.env.AUTOMATION_OS_DB ?? "" },
          encoding: "utf8",
          stdio: "pipe"
        }
      ),
    /Command failed/
  );

  const runs = db.querySql<{ id: string }>("SELECT id FROM runs WHERE id LIKE 'run_nisenprints_reconcile_%'");
  assert.deepEqual(runs, []);
  const receipt = JSON.parse(readFileSync(join(outDir, "nisenprints-completion-reconciliation-receipt.json"), "utf8")) as {
    ok: boolean;
    accepted_partial: boolean;
    accepted_partial_reason: string | null;
    project_run: {
      public_local_completion_observed: boolean;
      artifact_identity_consistent: boolean;
      proof_gate: { ok: boolean; missing: string[] };
    };
  };
  assert.equal(receipt.ok, false);
  assert.equal(receipt.accepted_partial, false);
  assert.equal(receipt.accepted_partial_reason, null);
  assert.equal(receipt.project_run.public_local_completion_observed, false);
  assert.equal(receipt.project_run.artifact_identity_consistent, false);
  assert.equal(receipt.project_run.proof_gate.ok, false);
  assert.ok(receipt.project_run.proof_gate.missing.includes("nisenprints_public_local_completion"));
});

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

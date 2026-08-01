import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-reference-canary-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");
process.env.AUTOMATION_OS_ARTIFACT_ROOT = join(tempRoot, "artifacts");
delete process.env.AUTOMATION_OS_DATABASE_URL;
delete process.env.DATABASE_URL;

const { runReferenceWorkflowCanary, referenceWorkflowCanarySchema } = await import("../runs/referenceWorkflowCanary.js");

test.after(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

test("reference workflow canary refuses non-temporary database and artifact paths", async () => {
  const previousDb = process.env.AUTOMATION_OS_DB;
  const previousArtifacts = process.env.AUTOMATION_OS_ARTIFACT_ROOT;
  process.env.AUTOMATION_OS_DB = join(process.cwd(), "data", "automation-os.sqlite");
  process.env.AUTOMATION_OS_ARTIFACT_ROOT = join(process.cwd(), "data", "artifacts");
  try {
    await assert.rejects(runReferenceWorkflowCanary(), /reference_workflow_canary_database_binding_mismatch/);
  } finally {
    process.env.AUTOMATION_OS_DB = previousDb;
    process.env.AUTOMATION_OS_ARTIFACT_ROOT = previousArtifacts;
  }
});

test("reference workflow canary validates the immutable imported database binding", async () => {
  const previousDb = process.env.AUTOMATION_OS_DB;
  process.env.AUTOMATION_OS_DB = join(tempRoot, "different-fresh.sqlite");
  try {
    await assert.rejects(runReferenceWorkflowCanary(), /reference_workflow_canary_database_binding_mismatch/);
    assert.equal(existsSync(process.env.AUTOMATION_OS_DB), false);
  } finally {
    process.env.AUTOMATION_OS_DB = previousDb;
  }
});

test("reference workflow canary refuses an existing temporary database", async () => {
  const existingDb = process.env.AUTOMATION_OS_DB!;
  writeFileSync(existingDb, "existing");
  try {
    await assert.rejects(runReferenceWorkflowCanary(), /reference_workflow_canary_fresh_database_required/);
  } finally {
    unlinkSync(existingDb);
  }
});

test("reference workflow canary proves three runner routes stop before external execution", async () => {
  const receipt = await runReferenceWorkflowCanary();

  assert.equal(receipt.schema, referenceWorkflowCanarySchema);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.safety_reference_paths_ok, true);
  assert.equal(receipt.reference_paths_complete, false);
  assert.equal(receipt.external_action_executed, false);
  assert.equal(receipt.mode, "isolated_sqlite_proof_backed_safe_stop_canary");
  assert.deepEqual(receipt.scope, { database: "ephemeral_tmp", artifacts: "ephemeral_tmp", approval_model: "billing_only_no_start_approval" });
  assert.deepEqual(receipt.paths.map((path) => path.id).sort(), [
    "daily-ai-research-publish-run",
    "job-application-manager",
    "nisenprints-daily-product-canva-printify-etsy-pinterest"
  ]);
  assert.ok(receipt.paths.every((path) => path.status === "proof_backed_safe_stop_verified"));
  assert.ok(receipt.paths.every((path) => path.exact_blocker === "in_app_browser_required"));
  assert.ok(receipt.paths.every((path) => path.run_blocked && path.step_blocked));
  assert.ok(receipt.paths.every((path) => path.proof_gate_ok === false));
  assert.ok(receipt.paths.every((path) => path.runner_exit_status === null));
  assert.ok(receipt.paths.every((path) => !path.runner_started && !path.runner_completed));
  assert.ok(receipt.paths.every((path) => path.external_action_executed === false && path.idempotent_recheck));
  assert.ok(receipt.paths.every((path) => path.approval_boundary_verified));
  assert.ok(receipt.paths.every((path) => path.company_scope_verified));
  assert.ok(receipt.paths.every((path) => path.start_lineage_verified));
  assert.ok(receipt.paths.every((path) => path.worker_blocked_event_verified));
  assert.ok(receipt.paths.every((path) => path.safety_proof_verified));
  assert.ok(receipt.paths.every((path) => path.runtime_binding_verified));
  assert.ok(receipt.paths.every((path) => path.cleanup_receipt_verified));
  assert.ok(receipt.paths.every((path) => /^[a-f0-9]{64}$/.test(path.cleanup_receipt_sha256 ?? "")));
  assert.ok(receipt.paths.every((path) => path.completion_claimed === false && path.operation_proof_gate_ok === false));
  assert.ok(receipt.paths.every((path) => /^[a-f0-9]{64}$/.test(path.definition_fingerprint)));
  assert.ok(receipt.paths.every((path) => /^[a-f0-9]{64}$/.test(path.schedule_fingerprint)));
  assert.equal(existsSync(process.env.AUTOMATION_OS_DB!), true);
});

test("reference workflow canary CLI writes a reusable receipt without external action", async () => {
  const output = join(tempRoot, "reference-workflow-canary.json");
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, [join(process.cwd(), "apps/server/dist/cli/referenceWorkflowCanary.js"), "--output", output], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AUTOMATION_OS_DB: join(tempRoot, "cli-automation-os.sqlite"),
      AUTOMATION_OS_ARTIFACT_ROOT: join(tempRoot, "cli-artifacts"),
      AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT: "0",
      AUTOMATION_OS_OBSIDIAN_PERIODIC_EXPORT_MS: "0",
      AUTOMATION_OS_RESEARCH_PLAN_SCHEDULER_MS: "0"
    },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(readFileSync(output, "utf8")) as {
    ok: boolean;
    safety_reference_paths_ok: boolean;
    reference_paths_complete: boolean;
    paths: unknown[];
    external_action_executed: boolean;
  };
  assert.equal(receipt.ok, true);
  assert.equal(receipt.safety_reference_paths_ok, true);
  assert.equal(receipt.reference_paths_complete, false);
  assert.equal(receipt.paths.length, 3);
  assert.equal(receipt.external_action_executed, false);
});

test("reference workflow canary rejects a temporary symlink that escapes the isolated root", async () => {
  const escapeLink = join(tempRoot, "escape-link");
  symlinkSync(homedir(), escapeLink, "dir");
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, [
    join(process.cwd(), "apps/server/dist/cli/referenceWorkflowCanary.js"),
    "--output",
    join(tempRoot, "symlink-escape-receipt.json")
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AUTOMATION_OS_DB: join(escapeLink, "escaped-canary.sqlite"),
      AUTOMATION_OS_ARTIFACT_ROOT: join(escapeLink, "escaped-artifacts"),
      AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT: "0",
      AUTOMATION_OS_OBSIDIAN_PERIODIC_EXPORT_MS: "0",
      AUTOMATION_OS_RESEARCH_PLAN_SCHEDULER_MS: "0"
    },
    encoding: "utf8"
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /reference_workflow_canary_isolated_temp_paths_required/);
  assert.equal(existsSync(join(process.cwd(), "escaped-canary.sqlite")), false);
});

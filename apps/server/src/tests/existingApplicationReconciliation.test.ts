import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "automation-os-existing-application-reconciliation-"));
const artifactRoot = join(root, "artifacts");
mkdirSync(artifactRoot, { recursive: true });
process.env.AUTOMATION_OS_DB = join(root, "automation-os.sqlite");
process.env.AUTOMATION_OS_ARTIFACT_ROOT = artifactRoot;
process.env.NODE_TEST_CONTEXT = "1";

const db = await import("../db/client.js");
const reconciliation = await import("../jobApplications/existingApplicationReconciliation.js");

const companyId = "existing_application_reconciliation_company";
const artifactPath = join(artifactRoot, "aos-reconciliation-readback.json");
const artifact = {
  schema: "aos_application_reconciliation_readback.v1",
  target: {
    job_url: "https://www.linkedin.com/jobs/view/4426853059/",
    company: "Rokt",
    role: "Customer Success Manager, Rokt Ads"
  },
  browser_auth: {
    backend: "chrome_plugin",
    profile_id: "profile2",
    auth_ref: "auth:chrome-profile2",
    company_connection_ref_required: false
  },
  provider_readback: {
    surface: "Chrome Plugin / Profile 2",
    visible_confirmation: "Application status: Application submitted",
    visible_submission_success: true,
    same_run_receipt: false,
    additional_external_action_executed: false
  },
  chrome_agent_tab_cleanup: { status: "verified", remaining_tabs: 0 },
  external_action_executed: false
};
const artifactBytes = Buffer.from(JSON.stringify(artifact));
const artifactSha256 = createHash("sha256").update(artifactBytes).digest("hex");

test("reconciliation-only records a verified Profile 2 readback without a new effect", () => {
  db.initDb();
  db.insert("companies", {
    id: companyId,
    slug: companyId,
    name: "Existing Application Reconciliation",
    status: "active",
    created_at: db.nowIso(),
    updated_at: db.nowIso()
  });
  writeFileSync(artifactPath, artifactBytes, { mode: 0o600 });

  const first = reconciliation.recordExistingApplicationReconciliation({
    companyId,
    idempotencyKey: "existing-application-reconciliation-001",
    reconciliation: { artifactRef: artifactPath, artifactSha256 }
  });
  assert.equal(first.replayed, false);
  assert.equal(first.browser_auth.auth_ref, "auth:chrome-profile2");
  assert.equal(first.provider_readback.same_run_submission_receipt, false);
  assert.equal(first.external_action_executed, false);
  assert.equal(first.business_completion_claimed, false);
  assert.equal(first.reconciliation.mode, "reconciliation_only");
  assert.equal(db.querySql<{ count: number }>(`SELECT count(*) AS count FROM runs WHERE id=${db.sqlValue(first.run.id)}`)[0].count, 1);
  assert.equal(db.querySql<{ count: number }>(`SELECT count(*) AS count FROM proofs WHERE run_id=${db.sqlValue(first.run.id)}`)[0].count, 1);

  const replay = reconciliation.recordExistingApplicationReconciliation({
    companyId,
    idempotencyKey: "existing-application-reconciliation-001",
    reconciliation: { artifactRef: artifactPath, artifactSha256 }
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.run.id, first.run.id);
  assert.equal(db.querySql<{ count: number }>(`SELECT count(*) AS count FROM runs WHERE company_id=${db.sqlValue(companyId)}`)[0].count, 1);
});

test("reconciliation-only rejects a changed artifact hash before mutating AOS", () => {
  assert.throws(
    () => reconciliation.recordExistingApplicationReconciliation({
      companyId,
      idempotencyKey: "existing-application-reconciliation-002",
      reconciliation: { artifactRef: artifactPath, artifactSha256: "f".repeat(64) }
    }),
    /reconciliation_artifact_sha256_mismatch/
  );
  assert.equal(db.querySql<{ count: number }>(`SELECT count(*) AS count FROM runs WHERE company_id=${db.sqlValue(companyId)}`)[0].count, 1);
});

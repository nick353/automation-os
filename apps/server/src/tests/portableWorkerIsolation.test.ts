import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const testRoot = mkdtempSync(join(tmpdir(), "automation-os-portable-isolation-"));
process.env.AUTOMATION_OS_DB = join(testRoot, "automation-os.sqlite");

const { initDb, insert, querySql } = await import("../db/client.js");
const { listClaimablePortableRuns, quarantineLegacyRuns } = await import("../runs/portableWorkerIsolation.js");

test("quarantine is additive and makes a queued run unclaimable", () => {
  initDb();
  const now = new Date().toISOString();
  insert("runs", {
    id: "portable-isolation-legacy",
    name: "legacy queued run",
    status: "queued",
    objective: "must not be replayed",
    created_at: now,
    updated_at: now,
    metadata_json: { source: "legacy" },
    execution_source: "legacy",
    quarantined: 0
  });

  const result = quarantineLegacyRuns(["portable-isolation-legacy"]);
  assert.deepEqual(result.quarantined, ["portable-isolation-legacy"]);
  assert.equal(listClaimablePortableRuns().some((row) => row.id === "portable-isolation-legacy"), false);
  const row = querySql<{ status: string; execution_source: string; quarantined: number; readback_proof_id: string | null }>(
    "SELECT status, execution_source, quarantined, readback_proof_id FROM runs WHERE id='portable-isolation-legacy'"
  )[0];
  assert.equal(row.status, "queued");
  assert.equal(row.execution_source, "legacy");
  assert.equal(row.quarantined, 1);
  assert.equal(row.readback_proof_id, null);
});

test("portable worker claim list excludes legacy and quarantined rows", () => {
  initDb();
  const now = new Date().toISOString();
  insert("runs", { id: "portable-isolation-claimable", name: "claimable", status: "queued", objective: "canary", created_at: now, updated_at: now, metadata_json: {}, execution_source: "automation-os", quarantined: 0 });
  insert("runs", { id: "portable-isolation-quarantined", name: "quarantined", status: "queued", objective: "no replay", created_at: now, updated_at: now, metadata_json: {}, execution_source: "automation-os", quarantined: 1 });
  insert("runs", { id: "portable-isolation-legacy-2", name: "legacy", status: "queued", objective: "no replay", created_at: now, updated_at: now, metadata_json: {}, execution_source: "legacy", quarantined: 0 });
  const ids = listClaimablePortableRuns().map((row) => row.id);
  assert.ok(ids.includes("portable-isolation-claimable"));
  assert.equal(ids.includes("portable-isolation-quarantined"), false);
  assert.equal(ids.includes("portable-isolation-legacy-2"), false);
});

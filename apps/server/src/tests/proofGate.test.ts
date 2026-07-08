import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRunContractProofGate, dailyAiRequiredProofs, evaluateProofGate } from "../runs/proofGate.js";
import { nisenPrintsRunContracts } from "../runs/runContracts.js";

test("fails when required proof is missing", () => {
  const evaluation = evaluateProofGate([{ proofType: "source_collection", label: "sources", uri: "x" }]);
  assert.equal(evaluation.ok, false);
  assert.ok(evaluation.missing.includes("x_publish"));
});

test("passes when Daily AI proof set is complete", () => {
  const evaluation = evaluateProofGate(
    dailyAiRequiredProofs.map((proofType) => ({ proofType, label: proofType, uri: `receipt://${proofType}` }))
  );
  assert.equal(evaluation.ok, true);
  assert.deepEqual(evaluation.missing, []);
});

test("fails contract proof gate when a required NisenPrints proof is missing", () => {
  const contract = nisenPrintsRunContracts.nisenprints_etsy_sync;
  const evaluation = evaluateRunContractProofGate(contract, [
    { proofType: "etsy_current_listings_snapshot", label: "current listings", uri: "receipt://etsy" }
  ]);

  assert.equal(evaluation.ok, false);
  assert.deepEqual(evaluation.present, ["etsy_current_listings_snapshot"]);
  assert.ok(evaluation.missing.includes("local_queue_synced"));
  assert.ok(evaluation.missing.includes("stale_rows_pruned"));
});

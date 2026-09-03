import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_COMPANION_WORKFLOW,
  DEFAULT_PATHS,
  loadArtifactBundle,
  validateArtifactBundle,
} from "../validate-daily-ai-artifacts.mjs";

function currentBundle() {
  return loadArtifactBundle(DEFAULT_PATHS);
}

test("current Daily AI and job artifacts pass one local consistency gate", () => {
  const bundle = currentBundle();
  const report = validateArtifactBundle({
    ...bundle,
    companionWorkflow: DEFAULT_COMPANION_WORKFLOW,
    generatedAt: "2026-08-30T00:00:00.000Z",
  });
  assert.equal(report.result, "passed_local_consistency_only");
  assert.equal(report.candidate_consistency.candidate_count, 4);
  assert.deepEqual(report.candidate_consistency.decision_counts, { apply: 0, skip: 0, hold: 4 });
  assert.equal(report.daily_ai_receipt.external_action_executed, false);
  assert.deepEqual(Object.values(report.daily_ai_receipt.downstream), ["unknown", "unknown", "unknown", "unknown", "unknown", "unknown"]);
  assert.equal(report.companion_workflow.separate_from_daily_ai, true);
});

test("rejects promotion of an unknown Daily AI downstream field", () => {
  const bundle = currentBundle();
  const mutatedDocuments = JSON.parse(JSON.stringify(bundle.documents));
  mutatedDocuments.audit.downstream_effect_readback.dispatch_count = 0;
  assert.throws(
    () => validateArtifactBundle({
      ...bundle,
      documents: mutatedDocuments,
      companionWorkflow: DEFAULT_COMPANION_WORKFLOW,
      generatedAt: "2026-08-30T00:00:00.000Z",
    }),
    (error) => error.code === "daily_ai_unknown_downstream_field_promoted",
  );
});

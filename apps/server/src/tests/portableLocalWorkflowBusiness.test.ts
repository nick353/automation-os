import assert from "node:assert/strict";
import test from "node:test";

import {
  obsidianBusinessPayloadHash,
  runPortableLocalWorkflowBusiness,
} from "../runs/portableLocalWorkflow.js";

test("Obsidian business adapter has a stable fixed target payload binding", () => {
  assert.match(obsidianBusinessPayloadHash(), /^[a-f0-9]{64}$/u);
  assert.equal(obsidianBusinessPayloadHash(), obsidianBusinessPayloadHash());
});

test("Obsidian business adapter rejects an unbound target before any Vault effect", () => {
  const result = runPortableLocalWorkflowBusiness({
    workflowId: "obsidian-project-memory-audit",
    workerRole: "mac",
    companyId: "portable-local-business-test-company",
    runId: "portable-local-business-test-run",
    stepId: "portable-local-business-test-step",
    idempotencyKey: "portable-local-business-test-key",
    targetDigest: "a".repeat(64),
    inputBundleSha256: "b".repeat(64),
    inputBundle: {
      account_ref: "github:unbound/foreign-vault",
      target_key: "foreign-vault:main",
      payload_hash: "c".repeat(64),
      source_snapshot_id: "snapshot-invalid-target",
    },
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.exact_blocker, "local_obsidian_target_binding_invalid");
  assert.equal(result.external_action_executed, false);
  assert.equal(result.business_completion_verified, false);
  assert.equal(result.adapter_result.operation_effect_state, "none");
});

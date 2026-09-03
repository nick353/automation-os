import assert from "node:assert/strict";
import test from "node:test";
import { buildTaskContractPreview } from "../taskContracts/taskContract.js";

const digest = "a".repeat(64);

test("reversible updates do not inherit the external-effect authority gate", () => {
  const contract = buildTaskContractPreview({
    contract_id: "contract-draft",
    task_id: "task-draft",
    workflow_id: "workflow-draft",
    task_class: "reversible_update",
    intent_kind: "update",
    intent_ref: "intent:draft",
    target_ref: "target:draft",
    target_digest: digest,
    account_ref: "account:local",
    payload_ref: "payload:draft",
    payload_digest: digest,
    audience: "workspace:draft",
    owner: "owner:local",
    idempotency_key: "idem-draft",
  });
  assert.equal(contract.status, "ready");
  assert.equal(contract.approval.required, false);
  assert.equal(contract.authority.ref, null);
  assert.equal(contract.authority.digest, null);
});
test("external effects still require explicit authority", () => {
  assert.throws(() => buildTaskContractPreview({
    contract_id: "contract-submit",
    task_id: "task-submit",
    workflow_id: "workflow-submit",
    task_class: "external_effect",
    intent_kind: "submit",
    intent_ref: "intent:submit",
    target_ref: "target:submit",
    target_digest: digest,
    account_ref: "account:local",
    payload_ref: "payload:submit",
    payload_digest: digest,
    audience: "provider:submit",
    owner: "owner:local",
    idempotency_key: "idem-submit",
  }), /task_contract_authority_required/u);
});

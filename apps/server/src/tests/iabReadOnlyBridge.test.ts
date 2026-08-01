import assert from "node:assert/strict";
import test from "node:test";

import {
  IAB_HANDLER_RECEIPT_SCHEMA,
  IAB_READONLY_CONTRACT_SCHEMA,
  IAB_RECEIPT_CONSUMPTION_SCHEMA,
  IAB_CONTRACT_VERSION,
  IabReceiptConsumptionStore,
  computeIabReceiptHash,
  consumeIabReadonlyReceipt,
  createTrustedStateRootProvenance,
  normalizeIabTargetRequest,
  validateIabHandlerReceipt,
  validateIabReadonlyContract
} from "../browser/iabReadOnlyBridge.js";
import { projectIabOwnerDiagnostics } from "../browser/iabOwnerDiagnostics.js";

const now = new Date("2026-07-22T00:00:00.000Z");
const trustedStateRootEvidence = {
  canonical_root: "/Users/nichikatanaka/Documents/Codex/automation-os/data" as const,
  realpath: "/Users/nichikatanaka/Documents/Codex/automation-os/data" as const,
  uid: typeof process.getuid === "function" ? process.getuid() : 0,
  mode: 0o700,
  receipt_realpath: "/Users/nichikatanaka/Documents/Codex/automation-os/data/iab/receipt-a.json",
  receipt_mode: 0o600,
  receipt_is_symlink: false as const,
  receipt_link_count: 1 as const,
  is_symlink: false as const,
  atomic_origin: true as const
};
const trusted = { trustedStateRootEvidence };

function blocker(result: { ok: boolean; exact_blocker?: string }): string | undefined {
  return result.ok ? undefined : result.exact_blocker;
}

function fixture() {
  const issued = new Date(now.getTime() - 10_000).toISOString();
  const expires = new Date(now.getTime() + 60_000).toISOString();
  const identity = { generation: "generation-a", project_id: "project-a", thread_id: "thread-a", session_id: "session-a", turn_id: "turn-a", nonce: "nonce-a", stage: "read", attempt: 1 };
  const targetBase = { url: "https://example.com/a?z=2&b=1", http_method: "GET", operation: "read_dom", redirect_scope: "same-origin" };
  const target = normalizeIabTargetRequest(targetBase);
  assert.equal(target.ok, true);
  const provenance = createTrustedStateRootProvenance({ generation: identity.generation, issued_at: issued });
  const contract = {
    schema: IAB_READONLY_CONTRACT_SCHEMA,
    contract_version: IAB_CONTRACT_VERSION,
    contract_id: "contract-a",
    issued_at: issued,
    expires_at: expires,
    ...identity,
    target: { ...targetBase, target_request_sha256: target.value.target_request_sha256 },
    proof: { screenshot_required: true, dom_readback_required: true },
    cleanup: { required: true },
    external_action: false,
    provenance
  };
  const receiptWithoutHash = {
    schema: IAB_HANDLER_RECEIPT_SCHEMA,
    contract_version: IAB_CONTRACT_VERSION,
    contract_id: contract.contract_id,
    receipt_id: "receipt-a",
    issued_at: issued,
    expires_at: expires,
    ...identity,
    target: contract.target,
    proof: { status: "verified", dom_readback: true, screenshot: { status: "present", path: "iab/receipt-a/screenshot.png", artifact_sha256: "a".repeat(64) } },
    cleanup: { status: "verified", no_residual_processes: true, no_external_action: true },
    external_action: false,
    provenance
  };
  const receipt = { ...receiptWithoutHash, receipt_hash_sha256: computeIabReceiptHash(receiptWithoutHash as never) };
  const claim = {
    schema: IAB_RECEIPT_CONSUMPTION_SCHEMA,
    contract_version: IAB_CONTRACT_VERSION,
    ...identity,
    contract_id: contract.contract_id,
    receipt_id: receipt.receipt_id,
    receipt_hash_sha256: receipt.receipt_hash_sha256,
    target_request_sha256: receipt.target.target_request_sha256
  };
  return { contract, receipt, claim };
}

test("validates a read-only contract, receipt, and one-use consumption", () => {
  const f = fixture();
  assert.equal(validateIabReadonlyContract(f.contract, { now, ...trusted }).ok, true);
  assert.equal(validateIabHandlerReceipt(f.receipt, { now, ...trusted }).ok, true);
  const store = new IabReceiptConsumptionStore();
  const consumed = consumeIabReadonlyReceipt({ ...f, store, now, ...trusted });
  assert.equal(consumed.ok, true);
  assert.equal(blocker(consumeIabReadonlyReceipt({ ...f, store, now, ...trusted })), "iab_receipt_already_consumed");
});

test("fails closed when a consumption store is omitted", () => {
  const f = fixture();
  assert.equal(blocker(consumeIabReadonlyReceipt({ ...f, now, ...trusted } as never)), "iab_consumption_store_required");
});

test("does not treat a self-claimed state-root attestation as trusted by default", () => {
  const f = fixture();
  assert.equal(blocker(validateIabReadonlyContract(f.contract, { now })), "iab_provenance_verifier_required");
  assert.equal(blocker(validateIabHandlerReceipt(f.receipt, { now })), "iab_provenance_verifier_required");
  assert.equal(validateIabReadonlyContract(f.contract, { now, ...trusted }).ok, true);
  assert.equal(validateIabReadonlyContract(f.contract, {
    now,
    trustedProvenanceVerifier: () => true
  }).ok, true);
  assert.equal(blocker(validateIabReadonlyContract(f.contract, {
    now,
    trustedStateRootEvidence: { ...trustedStateRootEvidence, realpath: "/tmp/attacker" as typeof trustedStateRootEvidence.realpath }
  })), "iab_provenance_evidence_invalid");
  assert.equal(blocker(validateIabReadonlyContract(f.contract, {
    now,
    trustedStateRootEvidence: { ...trustedStateRootEvidence, mode: 0o755 }
  })), "iab_provenance_evidence_invalid");
  assert.equal(blocker(validateIabReadonlyContract(f.contract, {
    now,
    trustedStateRootEvidence: { ...trustedStateRootEvidence, receipt_realpath: "/tmp/receipt.json" }
  })), "iab_provenance_evidence_invalid");
});

test("normalizes target and binds its hash across contract/receipt/claim", () => {
  const f = fixture();
  const normalized = normalizeIabTargetRequest({ url: "HTTPS://EXAMPLE.COM/a?b=1&z=2", method: "get", op: "read_dom", redirectScope: "same-origin" });
  assert.equal(normalized.ok, true);
  assert.equal(normalized.value.target_request_sha256, f.contract.target.target_request_sha256);
  const changed = { ...f.receipt, target: { ...f.receipt.target, url: "https://other.example/" } };
  assert.equal(blocker(validateIabHandlerReceipt(changed, { now, ...trusted })), "iab_target_hash_mismatch");
  assert.equal(blocker(normalizeIabTargetRequest({ ...f.receipt.target, method: "POST" })), "iab_target_method_alias_conflict");
  assert.equal(blocker(normalizeIabTargetRequest({ ...f.receipt.target, op: "click" })), "iab_target_operation_alias_conflict");
  assert.equal(blocker(normalizeIabTargetRequest({ ...f.receipt.target, unexpected: true } as never)), "iab_target_field_unexpected");
  const aliasConflict = { ...f.receipt, target: { ...f.receipt.target, http_method: "GET", method: "POST" }, receipt_hash_sha256: "" };
  assert.equal(blocker(validateIabHandlerReceipt(aliasConflict, { now, ...trusted })), "iab_target_method_alias_conflict");
});

test("blocks stale, future, long-lived, and generation/identity mismatches", () => {
  const f = fixture();
  assert.equal(blocker(validateIabHandlerReceipt({ ...f.receipt, expires_at: "2026-07-21T23:59:59.000Z" }, { now, ...trusted })), "iab_receipt_stale");
  assert.equal(blocker(validateIabHandlerReceipt({ ...f.receipt, issued_at: "2026-07-22T00:01:00.000Z" }, { now, ...trusted })), "iab_issued_at_future");
  assert.equal(blocker(validateIabHandlerReceipt({ ...f.receipt, expires_at: "2026-07-22T00:10:01.000Z" }, { now, ...trusted })), "iab_ttl_exceeds_max");
  assert.equal(blocker(consumeIabReadonlyReceipt({ ...f, claim: { ...f.claim, generation: "other" }, store: new IabReceiptConsumptionStore(), now, ...trusted })), "iab_consumption_binding_mismatch");
  assert.equal(blocker(consumeIabReadonlyReceipt({ ...f, receipt: { ...f.receipt, generation: "other" }, store: new IabReceiptConsumptionStore(), now, ...trusted })), "iab_provenance_attestation_invalid");
});

test("rejects untrusted provenance, mutation operations, external action, proof and cleanup gaps", () => {
  const f = fixture();
  assert.equal(blocker(validateIabHandlerReceipt({ ...f.receipt, provenance: { mode: "trusted_state_root", state_root: "/tmp/attacker", attestation: {} } }, { now, ...trusted })), "iab_provenance_untrusted");
  const forbiddenTarget = normalizeIabTargetRequest({ ...f.receipt.target, operation: "click" });
  assert.equal(blocker(forbiddenTarget), "iab_readonly_operation_forbidden");
  assert.equal(blocker(validateIabHandlerReceipt({ ...f.receipt, external_action: true }, { now, ...trusted })), "iab_external_action_forbidden");
  assert.equal(blocker(validateIabHandlerReceipt({ ...f.receipt, proof: { status: "verified", dom_readback: false, screenshot: true }, receipt_hash_sha256: "" }, { now, ...trusted })), "iab_proof_invalid");
  assert.equal(blocker(validateIabHandlerReceipt({ ...f.receipt, cleanup: { status: "verified", no_residual_processes: false, no_external_action: true }, receipt_hash_sha256: "" }, { now, ...trusted })), "iab_cleanup_invalid");
  assert.equal(blocker(validateIabHandlerReceipt({ ...f.receipt, proof: { status: "verified", dom_readback: true, screenshot: { status: "present", path: "/etc/passwd" } }, receipt_hash_sha256: "" }, { now, ...trusted })), "iab_proof_path_invalid");
});

test("owner diagnostics expose only a safe projection", () => {
  const f = fixture();
  const projection = projectIabOwnerDiagnostics({ contract: f.contract, receipt: f.receipt, now, existingWorkflowsUnchanged: true, ...trusted });
  assert.deepEqual(projection, {
    state: "ready", contract_version: "v1", receipt_fresh: true, consumed: false, provenance: "trusted_state_root",
    generation: "match", proof: "verified", cleanup: "verified", age_ms: 10_000, binding: "matched", exact_blocker: null,
    existing_workflows_unchanged: true
  });
  const text = JSON.stringify(projection);
  for (const secret of ["contract-a", "receipt-a", "nonce-a", "screenshot.png", "example.com"]) assert.equal(text.includes(secret), false);
  const blocked = projectIabOwnerDiagnostics({ contract: f.contract, receipt: { ...f.receipt, generation: "other" }, now, ...trusted });
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.exact_blocker, "iab_provenance_attestation_invalid");
  const identityMismatchReceiptWithoutHash = { ...f.receipt, thread_id: "other-thread" };
  const identityMismatchReceipt = { ...identityMismatchReceiptWithoutHash, receipt_hash_sha256: computeIabReceiptHash(identityMismatchReceiptWithoutHash as never) };
  const identityMismatch = projectIabOwnerDiagnostics({ contract: f.contract, receipt: identityMismatchReceipt, now, existingWorkflowsUnchanged: true, ...trusted });
  assert.equal(identityMismatch.state, "blocked");
  assert.equal(identityMismatch.binding, "mismatch");
  assert.equal(identityMismatch.exact_blocker, "iab_receipt_contract_binding_mismatch");
  const unverifiedWorkflows = projectIabOwnerDiagnostics({ contract: f.contract, receipt: f.receipt, now, ...trusted });
  assert.equal(unverifiedWorkflows.state, "blocked");
  assert.equal(unverifiedWorkflows.existing_workflows_unchanged, false);
  assert.equal(unverifiedWorkflows.exact_blocker, "iab_existing_workflows_unchanged_unverified");
  const consumedWithoutEvidence = projectIabOwnerDiagnostics({ contract: f.contract, receipt: f.receipt, consumed: true, now, ...trusted });
  assert.equal(consumedWithoutEvidence.state, "blocked");
  assert.equal(consumedWithoutEvidence.exact_blocker, "iab_existing_workflows_unchanged_unverified");
});

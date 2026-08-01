import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPANY_RELEASE_READINESS_SCHEMA_V1,
  buildBlockedCompanyReleaseReadinessV1,
  parseCompanyReleaseReadinessV1,
  validateCompanyReleaseReadinessV1
} from "../serviceReadiness/companyReleaseReadiness.js";

const blockedField = (exact_blocker: string, safe_resume_step: string) => ({
  status: "blocked",
  exact_blocker,
  blocker_owner: null,
  safe_resume_step
});

function blockedPacket() {
  return {
    schema: COMPANY_RELEASE_READINESS_SCHEMA_V1,
    mode: "no_effect_readiness",
    status: "blocked",
    activation_requested: false,
    activation_authorized: false,
    external_action_executed: false,
    named_g0_approvers_and_decisions: blockedField("named_g0_approvers_and_decisions_missing", "Obtain named G0 approvers and signed decisions."),
    mixed_file_hunk_allowlist_owner: blockedField("mixed_file_hunk_allowlist_owner_missing", "Assign the hunk allowlist owner and approval."),
    clean_candidate_sha_and_signed_manifest: blockedField("clean_candidate_sha_and_signed_manifest_missing", "Create a clean candidate and signed manifest."),
    backup_restore_rollback_owner: blockedField("backup_restore_rollback_owner_missing", "Name the backup restore and rollback owner."),
    per_workflow_account_target_payload_receipt_contract: blockedField("per_workflow_account_target_payload_receipt_contract_missing", "Define all three workflow receipt contracts."),
    exact_blocker: "company_release_required_fields_missing",
    blocker_owner: null,
    safe_resume_step: "Resolve the five required fields, then revalidate a fresh no-effect packet."
  };
}

function verifiedPacket(mode: "no_effect_readiness" | "activation" = "no_effect_readiness") {
  const packet = {
    schema: COMPANY_RELEASE_READINESS_SCHEMA_V1,
    mode,
    status: "ready",
    activation_requested: mode === "activation",
    activation_authorized: mode === "activation",
    external_action_executed: false,
    named_g0_approvers_and_decisions: {
      status: "verified",
      value: {
        approvers: [{ name: "Aiko Owner", role: "Product owner", decision: "approved", decided_at: "2026-07-22T00:00:00Z" }],
        decision_pack_sha256: "a".repeat(64)
      }
    },
    mixed_file_hunk_allowlist_owner: {
      status: "verified",
      value: { owner: "Release owner", allowlist_sha256: "b".repeat(64), approved_at: "2026-07-22T00:00:00Z" }
    },
    clean_candidate_sha_and_signed_manifest: {
      status: "verified",
      value: {
        candidate_sha: "c".repeat(64),
        signed_manifest_sha256: "d".repeat(64),
        signature: "sig:release-owner:2026-07-22",
        dirty: false,
        verified: true
      }
    },
    backup_restore_rollback_owner: {
      status: "verified",
      value: { owner: "SRE owner", restore_proof: "restore-drill-2026-07-22", rollback_plan: "rollback-plan-2026-07-22" }
    },
    per_workflow_account_target_payload_receipt_contract: {
      status: "verified",
      value: {
        workflows: [
          { workflow_id: "daily-ai", account: "account-ref-daily-ai", target: "target-daily-ai", payload_hash: "e".repeat(64), provider_receipt_contract: "receipt contract daily-ai" },
          { workflow_id: "job-application-manager", account: "account-ref-job-manager", target: "target-job-manager", payload_hash: "f".repeat(64), provider_receipt_contract: "receipt contract job-manager" },
          { workflow_id: "nisenprints", account: "account-ref-nisenprints", target: "target-nisenprints", payload_hash: "0".repeat(64), provider_receipt_contract: "receipt contract nisenprints" }
        ]
      }
    },
    exact_blocker: null,
    blocker_owner: null,
    safe_resume_step: null
  };
  return packet;
}

test("accepts an explicit blocked no-effect packet and preserves blockers", () => {
  const packet = blockedPacket();
  const result = validateCompanyReleaseReadinessV1(packet);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.mode, "no_effect_readiness");
    assert.equal(result.value.external_action_executed, false);
    assert.equal(result.value.exact_blocker, "company_release_required_fields_missing");
    assert.equal(result.value.named_g0_approvers_and_decisions.status, "blocked");
  }
});

test("builds the owner-safe blocked release packet without inventing evidence", () => {
  const packet = buildBlockedCompanyReleaseReadinessV1();
  const result = validateCompanyReleaseReadinessV1(packet);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.activation_authorized, false);
    assert.equal(result.value.external_action_executed, false);
    assert.equal(result.value.clean_candidate_sha_and_signed_manifest.status, "blocked");
    assert.equal(result.value.per_workflow_account_target_payload_receipt_contract.status, "blocked");
  }
});

test("rejects unknown, missing, and placeholder fields", () => {
  const unknown = blockedPacket() as Record<string, unknown>;
  unknown.unexpected = true;
  const unknownResult = validateCompanyReleaseReadinessV1(unknown);
  assert.equal(unknownResult.ok, false);
  if (!unknownResult.ok) assert.match(unknownResult.exact_blocker, /unknown_field:unexpected/);

  const missing = blockedPacket() as Record<string, unknown>;
  delete missing.backup_restore_rollback_owner;
  const missingResult = validateCompanyReleaseReadinessV1(missing);
  assert.equal(missingResult.ok, false);
  if (!missingResult.ok) assert.match(missingResult.exact_blocker, /field_missing:backup_restore_rollback_owner/);

  const placeholder = blockedPacket() as any;
  placeholder.mixed_file_hunk_allowlist_owner.safe_resume_step = "TBD";
  const placeholderResult = validateCompanyReleaseReadinessV1(placeholder);
  assert.equal(placeholderResult.ok, false);
  if (!placeholderResult.ok) assert.match(placeholderResult.exact_blocker, /safe_resume_step_invalid/);
});

test("rejects dirty, unverified, or unsigned candidate evidence", () => {
  for (const mutation of [
    (candidate: any) => { candidate.dirty = true; },
    (candidate: any) => { candidate.verified = false; },
    (candidate: any) => { candidate.signature = "TBD"; }
  ]) {
    const packet = verifiedPacket() as any;
    mutation(packet.clean_candidate_sha_and_signed_manifest.value);
    const result = validateCompanyReleaseReadinessV1(packet);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.exact_blocker, /candidate_dirty|candidate_unverified|signature_invalid/);
  }
});

test("keeps no-effect readiness separate from activation", () => {
  const noEffect = parseCompanyReleaseReadinessV1(verifiedPacket());
  assert.equal(noEffect.mode, "no_effect_readiness");
  assert.equal(noEffect.activation_authorized, false);

  const activation = parseCompanyReleaseReadinessV1(verifiedPacket("activation"));
  assert.equal(activation.mode, "activation");
  assert.equal(activation.activation_authorized, true);

  const forged = verifiedPacket("activation") as any;
  forged.external_action_executed = true;
  const forgedResult = validateCompanyReleaseReadinessV1(forged);
  assert.equal(forgedResult.ok, false);
  if (!forgedResult.ok) assert.equal(forgedResult.exact_blocker, "company_release_external_action_forbidden");
});

test("activation cannot proceed with any blocked required field", () => {
  const packet = verifiedPacket("activation") as any;
  packet.status = "blocked";
  packet.exact_blocker = "candidate_not_ready";
  packet.safe_resume_step = "Create a clean candidate and signed manifest.";
  packet.clean_candidate_sha_and_signed_manifest = blockedField("candidate_not_ready", "Create a clean candidate and signed manifest.");
  const result = validateCompanyReleaseReadinessV1(packet);
  assert.equal(result.ok, false);
  assert.equal(result.exact_blocker, "company_release_activation_blocked");
});

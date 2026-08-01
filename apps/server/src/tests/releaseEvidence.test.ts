import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPANY_RELEASE_EVIDENCE_SCHEMA_V1,
  buildBlockedCompanyReleaseEvidenceV1,
  computeCompanyReleaseEvidenceValueSha256V1,
  parseCompanyReleaseEvidenceV1,
  validateCompanyReleaseEvidenceV1
} from "../serviceReadiness/releaseEvidence.js";

const hash = (value: string) => value.repeat(64).slice(0, 64);
const verifiedEnvelope = (value: unknown, key: string) => {
  const canonical_value_sha256 = computeCompanyReleaseEvidenceValueSha256V1(value);
  return {
    status: "verified" as const,
    value,
    evidence_uri: `file:///tmp/company-release-evidence/${key}.json`,
    evidence_sha256: canonical_value_sha256,
    canonical_value_sha256,
    verified_at: "2026-07-22T05:00:00Z",
    verifier: "release-verifier"
  };
};
const verifiedOptions = (packet = verifiedPacket()) => ({
  trusted_verifier_ids: ["release-verifier"],
  evidence_readback: Object.fromEntries(
    [
      packet.named_g0_approvers_and_decisions,
      packet.mixed_file_hunk_allowlist_owner,
      packet.clean_candidate_sha_and_signed_manifest,
      packet.backup_restore_rollback_owner,
      packet.per_workflow_account_target_payload_receipt_contract,
      packet.incident_recovery_drill
    ].filter((entry): entry is { status: "verified"; value: unknown; evidence_uri: string; evidence_sha256: string; canonical_value_sha256: string; verified_at: string; verifier: string } => entry.status === "verified")
      .map((entry) => [entry.evidence_uri, entry.evidence_sha256])
  ),
  now_ms: Date.parse("2026-07-22T06:00:00Z"),
  max_age_ms: 24 * 60 * 60 * 1000,
  expected_candidate_sha: hash("d"),
  expected_source_commit: hash("0")
});

function verifiedPacket() {
  return {
    schema: COMPANY_RELEASE_EVIDENCE_SCHEMA_V1,
    status: "ready",
    external_action_executed: false,
    named_g0_approvers_and_decisions: verifiedEnvelope({
      decisions: [{ decision_id: "g0-idp", name: "Owner", role: "owner", decision: "approved", decided_at: "2026-07-22T04:00:00Z" }],
      decision_pack_sha256: hash("b")
    }, "g0"),
    mixed_file_hunk_allowlist_owner: verifiedEnvelope({
      owner: "Release owner",
      allowlist_sha256: hash("c"),
      approved_at: "2026-07-22T04:00:00Z"
    }, "hunk"),
    clean_candidate_sha_and_signed_manifest: verifiedEnvelope({
      candidate_sha: hash("d"),
      manifest_sha256: hash("e"),
      sbom_sha256: hash("f"),
      signature: "sigstore:release-owner:2026-07-22",
      signature_algorithm: "sigstore",
      source_commit: hash("0"),
      clean_checkout: true,
      signature_verified: true,
      manifest_matches_candidate: true
    }, "candidate"),
    backup_restore_rollback_owner: verifiedEnvelope({
      owner: "SRE owner",
      backup_id: "backup-20260722",
      backup_manifest_sha256: hash("1"),
      restore_drill_id: "restore-drill-20260722",
      restore_readback_sha256: hash("2"),
      rollback_anchor: `candidate_sha:${hash("d")}`,
      rollback_readback_sha256: hash("3"),
      restore_executed: true,
      rollback_readback_verified: true
    }, "backup"),
    per_workflow_account_target_payload_receipt_contract: verifiedEnvelope({
      workflows: [
        { workflow_id: "daily-ai", account_ref: "daily-account", target_ref: "linkedin:no-post-canary", payload_hash: hash("4"), provider: "linkedin", provider_receipt_contract: "read-only-post-receipt.v1", idempotency_key: "daily-idem", unknown_outcome_owner: "Daily owner", cleanup_receipt_schema: "service_readiness_cleanup_receipt.v1", rollback_contract: "no-external-effect" },
        { workflow_id: "job-application-manager", account_ref: "job-account", target_ref: "job-board:target", payload_hash: hash("5"), provider: "gmail", provider_receipt_contract: "gmail-capture-receipt.v1", idempotency_key: "job-idem", unknown_outcome_owner: "Job owner", cleanup_receipt_schema: "service_readiness_cleanup_receipt.v1", rollback_contract: "no-submit-on-ambiguous" },
        { workflow_id: "nisenprints", account_ref: "nisen-account", target_ref: "listing:target", payload_hash: hash("6"), provider: "printify", provider_receipt_contract: "listing-receipt.v1", idempotency_key: "nisen-idem", unknown_outcome_owner: "Nisen owner", cleanup_receipt_schema: "service_readiness_cleanup_receipt.v1", rollback_contract: "listing-dedupe-readback" }
      ]
    }, "workflow"),
    incident_recovery_drill: verifiedEnvelope({
      owner: "Incident owner",
      drill_id: "incident-drill-20260722",
      scenario: "worker crash after lease and before provider receipt",
      recovery_readback_sha256: hash("7"),
      cleanup_readback_sha256: hash("8"),
      rollback_anchor: `candidate_sha:${hash("d")}`,
      passed: true
    }, "incident"),
    exact_blocker: null,
    blocker_owner: null,
    safe_resume_step: null
  };
}

test("builds an explicit blocked packet without inventing release evidence", () => {
  const packet = buildBlockedCompanyReleaseEvidenceV1();
  const result = validateCompanyReleaseEvidenceV1(packet);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.status, "blocked");
    assert.equal(result.value.external_action_executed, false);
    assert.equal(result.value.incident_recovery_drill.status, "blocked");
  }
});

test("accepts a complete, independently enveloped no-effect evidence packet", () => {
  const result = validateCompanyReleaseEvidenceV1(verifiedPacket(), verifiedOptions());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.status, "ready");
    assert.equal(result.value.exact_blocker, null);
    assert.equal(result.value.clean_candidate_sha_and_signed_manifest.status, "verified");
  }
});

test("rejects external action claims, stale candidate state, and failed restore evidence", () => {
  const external = verifiedPacket() as any;
  external.external_action_executed = true;
  const externalResult = validateCompanyReleaseEvidenceV1(external, verifiedOptions());
  assert.equal(externalResult.ok, false);
  if (!externalResult.ok) assert.equal(externalResult.exact_blocker, "company_release_evidence_external_action_forbidden");

  const dirty = verifiedPacket() as any;
  dirty.clean_candidate_sha_and_signed_manifest.value.clean_checkout = false;
  const dirtyResult = validateCompanyReleaseEvidenceV1(dirty, verifiedOptions());
  assert.equal(dirtyResult.ok, false);
  if (!dirtyResult.ok) assert.equal(dirtyResult.exact_blocker, "company_release_candidate_not_clean");

  const restore = verifiedPacket() as any;
  restore.backup_restore_rollback_owner.value.restore_executed = false;
  const restoreResult = validateCompanyReleaseEvidenceV1(restore, verifiedOptions());
  assert.equal(restoreResult.ok, false);
  if (!restoreResult.ok) assert.equal(restoreResult.exact_blocker, "company_release_restore_not_executed");
});

test("rejects incomplete workflow contracts and unknown envelope fields", () => {
  const incomplete = verifiedPacket() as any;
  incomplete.per_workflow_account_target_payload_receipt_contract.value.workflows.pop();
  const incompleteResult = validateCompanyReleaseEvidenceV1(incomplete, verifiedOptions());
  assert.equal(incompleteResult.ok, false);
  if (!incompleteResult.ok) assert.equal(incompleteResult.exact_blocker, "company_release_workflow_receipt_three_required");

  const unknown = verifiedPacket() as any;
  unknown.incident_recovery_drill.extra = true;
  const unknownResult = validateCompanyReleaseEvidenceV1(unknown, verifiedOptions());
  assert.equal(unknownResult.ok, false);
  if (!unknownResult.ok) assert.match(unknownResult.exact_blocker, /company_release_evidence_unknown_field:extra/);
});

test("does not allow a ready packet to retain blocker fields", () => {
  const packet = verifiedPacket() as any;
  packet.safe_resume_step = "still blocked";
  const result = validateCompanyReleaseEvidenceV1(packet, verifiedOptions());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.exact_blocker, "company_release_evidence_ready_blocker_fields_forbidden");
});

test("parses the normalized contract without side effects", () => {
  const parsed = parseCompanyReleaseEvidenceV1(buildBlockedCompanyReleaseEvidenceV1());
  assert.equal(parsed.schema, COMPANY_RELEASE_EVIDENCE_SCHEMA_V1);
  assert.equal(parsed.external_action_executed, false);
});

test("requires a trusted fresh readback and rejects prefixed placeholders or semantic drift", () => {
  const packet = verifiedPacket() as any;
  const noTrust = validateCompanyReleaseEvidenceV1(packet, { ...verifiedOptions(), trusted_verifier_ids: [] });
  assert.equal(noTrust.ok, false);
  if (!noTrust.ok) assert.equal(noTrust.exact_blocker, "company_release_evidence_trusted_verifier_required");

  const stale = validateCompanyReleaseEvidenceV1(packet, {
    ...verifiedOptions(),
    now_ms: Date.parse("2026-07-24T06:00:00Z")
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.exact_blocker, "company_release_evidence_stale");

  const fakeReadback = validateCompanyReleaseEvidenceV1(packet, {
    ...verifiedOptions(),
    evidence_readback: { "file:///definitely/does/not/exist.json": hash("a") }
  });
  assert.equal(fakeReadback.ok, false);
  if (!fakeReadback.ok) assert.equal(fakeReadback.exact_blocker, "company_release_evidence_readback_required");

  const placeholder = verifiedPacket() as any;
  placeholder.per_workflow_account_target_payload_receipt_contract.value.workflows[0].target_ref = "Unknown target";
  const placeholderResult = validateCompanyReleaseEvidenceV1(placeholder, verifiedOptions());
  assert.equal(placeholderResult.ok, false);
  if (!placeholderResult.ok) assert.equal(placeholderResult.exact_blocker, "company_release_workflow_receipt_target_invalid");

  const provider = verifiedPacket() as any;
  provider.per_workflow_account_target_payload_receipt_contract.value.workflows[0].provider = "made-up";
  const providerResult = validateCompanyReleaseEvidenceV1(provider, verifiedOptions());
  assert.equal(providerResult.ok, false);
  if (!providerResult.ok) assert.equal(providerResult.exact_blocker, "company_release_workflow_receipt_provider_invalid");
});

test("binds signature format to its declared algorithm and provider receipt contracts to workflow pairs", () => {
  const signatureMismatch = verifiedPacket() as any;
  signatureMismatch.clean_candidate_sha_and_signed_manifest.value.signature_algorithm = "ed25519";
  const signatureResult = validateCompanyReleaseEvidenceV1(signatureMismatch, verifiedOptions());
  assert.equal(signatureResult.ok, false);
  if (!signatureResult.ok) assert.equal(signatureResult.exact_blocker, "company_release_candidate_signature_invalid");

  const receiptMismatch = verifiedPacket() as any;
  receiptMismatch.per_workflow_account_target_payload_receipt_contract.value.workflows[0].provider_receipt_contract = "made-up-contract.v1";
  const receiptResult = validateCompanyReleaseEvidenceV1(receiptMismatch, verifiedOptions());
  assert.equal(receiptResult.ok, false);
  if (!receiptResult.ok) assert.equal(receiptResult.exact_blocker, "company_release_workflow_receipt_contract_invalid");
});

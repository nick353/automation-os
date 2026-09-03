import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPortableExternalApprovalBinding,
  buildPortableTargetBoundApprovalReceipt,
  validatePortableTargetBoundApprovalReceipt,
} from "../runs/portableExternalApprovalBinding.js";
import {
  issuePortableExternalEffectAuthorityV1,
  validatePortableExternalEffectAuthorityV1,
} from "../runs/portableExternalEffectAuthority.js";

const bundle = {
  account_ref: "account:linkedin-profile2",
  target_key: "job_target_chrome_surface",
  job_url: "https://www.linkedin.com/jobs/view/4397686095/",
  application_url: "https://www.linkedin.com/jobs/view/4397686095/apply/",
  candidate_key: "job_target_chrome_surface",
  source_snapshot_id: "snapshot:chrome-surface",
  payload_hash: "c".repeat(64),
  company: "Apex",
  role: "AI Adoption Lead",
};

test("target-bound approval and effect authority preserve Chrome Plugin Profile 2 surface", () => {
  const binding = buildPortableExternalApprovalBinding({
    companyId: "company-chrome-surface",
    workflowId: "job-application-manager",
    runId: "run-chrome-surface",
    stepId: "step-chrome-surface",
    effectStage: "one_candidate_submit",
    idempotencyKey: "chrome-surface-submit",
    inputBundleSha256: "a".repeat(64),
    inputBundle: bundle,
    browserSurface: "signed_chrome_extension_profile2",
  });
  const approval = buildPortableTargetBoundApprovalReceipt({
    approvalId: "approval-chrome-surface",
    approvalStatus: "approved",
    decidedAt: new Date().toISOString(),
    binding,
  });
  const validatedApproval = validatePortableTargetBoundApprovalReceipt(approval, {
    company_id: "company-chrome-surface",
    workflow_id: "job-application-manager",
    run_id: "run-chrome-surface",
    step_id: "step-chrome-surface",
    effect_stage: "one_candidate_submit",
    idempotency_key: "chrome-surface-submit",
    input_bundle_sha256: "a".repeat(64),
    target_digest: binding.target_digest,
    browser_surface: "signed_chrome_extension_profile2",
  });
  assert.equal(validatedApproval.binding.browser_surface, "signed_chrome_extension_profile2");

  const authority = issuePortableExternalEffectAuthorityV1({
    companyId: "company-chrome-surface",
    workflowId: "job-application-manager",
    runId: "run-chrome-surface",
    stepId: "step-chrome-surface",
    effectStage: "one_candidate_submit",
    approvalId: "approval-chrome-surface",
    idempotencyKey: "chrome-surface-submit",
    targetDigest: binding.target_digest,
    inputBundleSha256: "a".repeat(64),
    payloadHash: "c".repeat(64),
    browserSurface: "signed_chrome_extension_profile2",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(authority.browser_surface, "signed_chrome_extension_profile2");
  assert.doesNotThrow(() => validatePortableExternalEffectAuthorityV1(authority, {
    company_id: "company-chrome-surface",
    workflow_id: "job-application-manager",
    run_id: "run-chrome-surface",
    step_id: "step-chrome-surface",
    effect_stage: "one_candidate_submit",
    approval_id: "approval-chrome-surface",
    idempotency_key: "chrome-surface-submit",
    target_digest: binding.target_digest,
    input_bundle_sha256: "a".repeat(64),
    browser_surface: "signed_chrome_extension_profile2",
  }));
});

import assert from "node:assert/strict";
import test from "node:test";
import { bindGmailExecutionTargetToRunInput } from "../runs/gmailExecutionTargetPropagation.js";
import type { CompanyConnectionRefRecord } from "../automations/repository.js";

const companyId = "company-gmail-propagation";
const gmail: CompanyConnectionRefRecord = {
  id: "gmail-ref-1",
  companyId,
  platform: "gmail",
  accountRef: "owner@example.com",
  status: "verified",
  scopes: ["read"],
  expiresAt: null,
  oauthState: "connected",
  verificationStatus: "verified",
  lastVerifiedAt: "2026-09-09T00:00:00.000Z",
  reconnectRequestedAt: null,
  revokedAt: null,
  revision: 1,
  createdAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z"
};

function automation(builderSpec: Record<string, unknown>) {
  return { companyId, builderSpec };
}

test("requires persisted canonical binding and copies it into a new Run bundle", () => {
  const result = bindGmailExecutionTargetToRunInput({
    automation: automation({ canonicalWorkflowId: "email-review-reply", execution_target: { connection_ref_id: gmail.id } }),
    connectionRefs: [gmail]
  });
  assert.deepEqual(result, { connection_ref_id: gmail.id, account_ref: gmail.accountRef });
});

test("does not let a caller-supplied bundle establish an unbound automation", () => {
  assert.throws(() => bindGmailExecutionTargetToRunInput({
    automation: automation({ canonicalWorkflowId: "email-review-reply" }),
    connectionRefs: [gmail],
    inputBundle: { connection_ref_id: gmail.id, account_ref: gmail.accountRef }
  }), /execution_target_unbound/);
});

test("rejects a Run bundle that disagrees with the persisted target", () => {
  assert.throws(() => bindGmailExecutionTargetToRunInput({
    automation: automation({ canonicalWorkflowId: "email-review-reply", execution_target: { connection_ref_id: gmail.id } }),
    connectionRefs: [gmail],
    inputBundle: { connection_ref_id: "gmail-ref-other" }
  }), /execution_target_run_connection_mismatch/);
  assert.throws(() => bindGmailExecutionTargetToRunInput({
    automation: automation({ canonicalWorkflowId: "email-review-reply", execution_target: { connection_ref_id: gmail.id } }),
    connectionRefs: [gmail],
    inputBundle: { account_ref: "other@example.com" }
  }), /execution_target_run_account_mismatch/);
});

test("leaves non-Gmail workflows unchanged", () => {
  const input = { account_ref: "unrelated-account" };
  assert.deepEqual(bindGmailExecutionTargetToRunInput({
    automation: automation({ canonicalWorkflowId: "daily-ai-research-publish-run" }),
    connectionRefs: [gmail],
    inputBundle: input
  }), input);
});

import assert from "node:assert/strict";
import test from "node:test";
import { resolveGmailExecutionTarget } from "../runs/gmailAccountBinding.js";
import type { CompanyConnectionRefRecord } from "../automations/repository.js";

const now = "2026-09-09T00:00:00.000Z";
const company = "company-1";

function ref(overrides: Partial<CompanyConnectionRefRecord> = {}): CompanyConnectionRefRecord {
  return {
    id: "gmail-1", companyId: company, platform: "gmail", accountRef: "mailbox-1", status: "verified", scopes: ["read"],
    expiresAt: null, oauthState: "connected", verificationStatus: "verified", lastVerifiedAt: now,
    reconnectRequestedAt: null, revokedAt: null, revision: 1, createdAt: now, updatedAt: now, ...overrides
  };
}
function automation(executionTarget?: Record<string, unknown>, canonicalWorkflowId = "email-review-reply") {
  return { companyId: company, builderSpec: { canonicalWorkflowId, ...(executionTarget === undefined ? {} : { execution_target: executionTarget }) } };
}
function resolve(target: Record<string, unknown> | undefined, refs: readonly CompanyConnectionRefRecord[] = [ref()]) {
  return resolveGmailExecutionTarget(automation(target), refs, now);
}

test("verified company Gmail alone remains unbound", () => {
  const result = resolve(undefined);
  assert.equal(result.state, "unbound");
  assert.equal(result.connection_evidence, "verified");
  assert.equal(result.external_action_allowed, false);
});

test("explicit connection ref binds, including camelCase target keys", () => {
  const result = resolve({ connectionRefId: "gmail-1", accountRef: "mailbox-1" });
  assert.equal(result.state, "bound");
  assert.equal(result.binding_evidence, "explicit_pair");
  assert.equal(result.connection_ref_id, "gmail-1");
  assert.equal(result.account_ref, "mailbox-1");
});

test("same account ref on unrelated providers does not create Gmail competition", () => {
  const result = resolve({ connection_ref_id: "gmail-1", account_ref: "mailbox-1" }, [
    ref(),
    ref({ id: "drive-1", platform: "google-drive" }),
    ref({ id: "supabase-1", platform: "supabase" })
  ]);
  assert.equal(result.state, "bound");
  assert.equal(result.connection_ref_id, "gmail-1");
  assert.equal(result.account_ref, "mailbox-1");
});

test("unknown connection ref is fail-closed and does not fall back to account ref", () => {
  const result = resolve({ connection_ref_id: "missing", account_ref: "mailbox-1" });
  assert.equal(result.state, "unknown_ref");
  assert.equal(result.exact_blocker, "execution_target_connection_ref_not_found");
  assert.equal(resolve({ connection_ref_id: "gmail-1", account_ref: "missing" }).state, "unknown_ref");
});

test("foreign connection ref is rejected as company mismatch", () => {
  const result = resolve({ connection_ref_id: "foreign" }, [ref({ id: "foreign", companyId: "company-2" })]);
  assert.equal(result.state, "company_mismatch");
});

test("pair mismatch and competing account matches are rejected", () => {
  const mismatch = resolve({ connection_ref_id: "gmail-1", account_ref: "mailbox-2" }, [ref(), ref({ id: "gmail-2", accountRef: "mailbox-2" })]);
  assert.equal(mismatch.state, "competing");
  const competing = resolve({ account_ref: "mailbox-1" }, [ref(), ref({ id: "gmail-2", accountRef: "mailbox-1" })]);
  assert.equal(competing.state, "competing");
  assert.equal(resolve({ connection_ref_id: "gmail-1", connectionRefId: "gmail-2" }, [ref(), ref({ id: "gmail-2", accountRef: "mailbox-2" })]).state, "competing");
});

test("non-Gmail, revoked, expired, and unverified refs are rejected distinctly", () => {
  assert.equal(resolve({ connection_ref_id: "other" }, [ref({ id: "other", platform: "github" })]).state, "non_gmail");
  assert.equal(resolve({ connection_ref_id: "revoked" }, [ref({ id: "revoked", status: "revoked", revokedAt: now })]).state, "revoked");
  assert.equal(resolve({ connection_ref_id: "expired" }, [ref({ id: "expired", expiresAt: "2026-09-08T23:59:59.000Z" })]).state, "expired");
  assert.equal(resolve({ connection_ref_id: "pending" }, [ref({ id: "pending", status: "pending" })]).state, "unverified");
});

test("missing Gmail read scope is rejected", () => {
  const result = resolve({ connection_ref_id: "gmail-1" }, [ref({ scopes: ["profile"] })]);
  assert.equal(result.state, "scope_insufficient");
  assert.equal(result.exact_blocker, "execution_target_gmail_read_scope_missing");
});

test("unrelated nested account values are never adopted", () => {
  const result = resolve(undefined);
  const nested = resolveGmailExecutionTarget({ companyId: company, builderSpec: { canonicalWorkflowId: "email-review-reply", metadata: { account_ref: "mailbox-1", connection_ref_id: "gmail-1" } } }, [ref()], now);
  assert.equal(result.state, "unbound");
  assert.equal(nested.state, "unbound");
  assert.equal(nested.connection_ref_id, null);
});

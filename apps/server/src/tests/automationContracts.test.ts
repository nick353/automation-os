import assert from "node:assert/strict";
import test from "node:test";
import {
  parseAutomationCreate,
  parseAutomationPatch,
  parseAutomationSchedule,
  parseCompanyConnectionAccountRef,
  parseCompanyMemory,
  requireIdempotencyKey
} from "../automations/contracts.js";

test("automation contracts normalize valid create and preserve explicit values", () => {
  const parsed = parseAutomationCreate({
    automation_type: "daily-ai",
    name: "Daily AI draft",
    description: "Create a local draft",
    goal: "Stop before external publishing",
    lane: "local",
    risk_level: "high",
    approval_policy: "required_before_external_action",
    worker_command_kind: "safe_local_demo",
    create_approval: true,
    builder_spec: { steps: ["research", "draft"] }
  });
  assert.equal(parsed.automationType, "daily-ai");
  assert.equal(parsed.name, "Daily AI draft");
  assert.equal(parsed.createApproval, true);
});

test("automation patch requires optimistic concurrency and rejects silent defaults", () => {
  assert.throws(() => parseAutomationPatch({ name: "Updated" }), /automation_expected_revision_required/);
  assert.throws(() => parseAutomationPatch({ expected_revision: 2 }), /automation_patch_empty/);
  assert.deepEqual(parseAutomationPatch({ expected_revision: 2, name: "Updated" }), {
    expectedRevision: 2,
    name: "Updated"
  });
});

test("automation contracts reject unknown fields and conflicting description aliases", () => {
  assert.throws(() => parseAutomationCreate({ automation_type: "demo", name: "Demo", mystery: true }), /automation_unknown_field:mystery/);
  assert.throws(() => parseAutomationCreate({ automation_type: "demo", name: "Demo", description: "a", desc: "b" }), /automation_description_conflict/);
});

test("automation schedule is typed and revisioned", () => {
  assert.deepEqual(parseAutomationSchedule({ kind: "daily", expression: "09:00", timezone: "Asia/Tokyo", enabled: true, expected_revision: 3 }), {
    kind: "daily",
    expression: "09:00",
    timezone: "Asia/Tokyo",
    enabled: true,
    expectedRevision: 3
  });
  assert.equal(parseAutomationSchedule({ kind: "daily", expression: "09:00", timezone: "Asia/Tokyo", expected_revision: 1 }).enabled, false);
  assert.throws(() => parseAutomationSchedule({ kind: "daily", timezone: "UTC", expected_revision: 1 }), /automation_schedule_expression_required/);
  assert.throws(() => parseAutomationSchedule({ kind: "manual", expression: "09:00", expected_revision: 1 }), /automation_manual_schedule_expression_forbidden/);
});

test("company memory is typed and revisioned on update", () => {
  assert.deepEqual(parseCompanyMemory({ key: "brand", kind: "brand", title: "Brand", body: "Calm and precise", expected_revision: 4 }, true), {
    key: "brand",
    kind: "brand",
    title: "Brand",
    body: "Calm and precise",
    expectedRevision: 4
  });
  assert.throws(() => parseCompanyMemory({ key: "brand", kind: "unknown", title: "Brand", body: "x" }), /company_memory_kind_invalid/);
});

test("connection refs reject secret material and validate scopes", () => {
  const parsed = parseCompanyConnectionAccountRef({
    platform: "linkedin",
    account_ref: "workspace-account-1",
    status: "verified",
    scopes: ["read_profile"],
    expires_at: "2027-01-01T00:00:00Z",
    oauth_state: "connected",
    verification_status: "verified",
    last_verified_at: "2026-12-31T23:00:00Z"
  });
  assert.equal(parsed.platform, "linkedin");
  assert.equal(parsed.expiresAt, "2027-01-01T00:00:00.000Z");
  assert.equal(parsed.oauthState, "connected");
  assert.equal(parsed.verificationStatus, "verified");
  assert.equal(parsed.lastVerifiedAt, "2026-12-31T23:00:00.000Z");
  assert.throws(() => parseCompanyConnectionAccountRef({ platform: "linkedin", account_ref: "a", token: "secret" }), /company_connection_secret_material_forbidden/);
  assert.throws(() => parseCompanyConnectionAccountRef({ platform: "linkedin", account_ref: "a", scopes: ["read", "read"] }), /company_connection_ref_scopes_duplicate/);
  assert.throws(() => parseCompanyConnectionAccountRef({ platform: "linkedin", account_ref: "a", oauth_state: "token_inside_row" }), /company_connection_ref_oauth_state_invalid/);
  assert.throws(() => parseCompanyConnectionAccountRef({ platform: "linkedin", account_ref: "a", verification_status: "verified" }), /company_connection_ref_last_verified_at_required/);
  assert.throws(() => parseCompanyConnectionAccountRef({ platform: "linkedin", account_ref: "a", status: "revoked" }), /company_connection_ref_lifecycle_action_required/);
  assert.throws(() => parseCompanyConnectionAccountRef({ platform: "linkedin", account_ref: "a", status: "verified" }), /company_connection_ref_verification_status_mismatch/);
  assert.throws(() => parseCompanyConnectionAccountRef({ platform: "linkedin", account_ref: "a", status: "configured", verification_status: "verified", last_verified_at: "2026-01-01T00:00:00Z" }), /company_connection_ref_status_mismatch/);
  assert.throws(() => parseCompanyConnectionAccountRef({ platform: "linkedin", account_ref: "a", status: "verified", verification_status: "verified", last_verified_at: "2026-01-01T00:00:00Z", oauth_state: "expired" }), /company_connection_ref_oauth_state_mismatch/);
});

test("idempotency keys are explicit and bounded", () => {
  assert.equal(requireIdempotencyKey("company-a:create:123"), "company-a:create:123");
  assert.throws(() => requireIdempotencyKey("short"), /idempotency_key_required/);
  assert.throws(() => requireIdempotencyKey("invalid key spaces"), /idempotency_key_invalid/);
});

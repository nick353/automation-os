import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-bound-approval-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");

const db = await import("../db/client.js");
const contracts = await import("../automations/contracts.js");
const automations = await import("../automations/repository.js");
const queue = await import("../runs/durableQueue.js");
const approvals = await import("../approvals/repository.js");

test("bound approval decision is revisioned, tenant scoped, and expires closed", () => {
  const fixture = seedFixture("company_approval_a", "owner_approval_a", "service_approval_a");
  const job = enqueue(fixture, "approval-decision-job");
  const approval = approvals.createBoundApproval({
    companyId: fixture.companyId,
    requestedByUserId: fixture.serviceUserId,
    jobId: job.id,
    title: "Publish exact payload",
    actionKind: "publish.post",
    payloadHash: "a".repeat(64),
    policyVersion: "policy-v1",
    expiresAt: "2030-01-01T00:00:00.000Z",
    now: "2029-01-01T00:00:00.000Z"
  });
  assert.equal(approval.status, "pending");
  assert.equal(approval.decisionRevision, 1);

  const decided = approvals.decideBoundApproval({
    companyId: fixture.companyId,
    approvalId: approval.id,
    actorUserId: fixture.ownerUserId,
    decision: "approved",
    expectedRevision: 1,
    now: "2029-01-01T01:00:00.000Z"
  });
  assert.equal(decided.status, "approved");
  assert.equal(decided.decisionRevision, 2);
  assert.throws(() => approvals.decideBoundApproval({
    companyId: fixture.companyId,
    approvalId: approval.id,
    actorUserId: fixture.ownerUserId,
    decision: "rejected",
    expectedRevision: 1,
    now: "2029-01-01T02:00:00.000Z"
  }), /approval_not_pending|approval_revision_conflict/);
  assert.equal(approvals.getBoundApproval("company_missing", approval.id), undefined);

  const expiring = approvals.createBoundApproval({
    companyId: fixture.companyId,
    requestedByUserId: fixture.serviceUserId,
    jobId: job.id,
    title: "Expiring",
    actionKind: "publish.post",
    payloadHash: "b".repeat(64),
    policyVersion: "policy-v1",
    expiresAt: "2029-01-01T00:00:01.000Z",
    now: "2029-01-01T00:00:00.000Z"
  });
  assert.throws(() => approvals.decideBoundApproval({
    companyId: fixture.companyId,
    approvalId: expiring.id,
    actorUserId: fixture.ownerUserId,
    decision: "approved",
    expectedRevision: 1,
    now: "2029-01-01T00:00:02.000Z"
  }), /approval_expired/);
});

test("company approval inbox includes portable approvals without making them consumable bound approvals", () => {
  const fixture = seedFixture("company_approval_portable_inbox", "owner_approval_portable_inbox", "service_approval_portable_inbox");
  const now = "2029-01-01T00:00:00.000Z";
  db.insert("approvals", {
    id: "approval_portable_inbox",
    company_id: fixture.companyId,
    run_id: "run_portable_inbox",
    job_id: null,
    step_id: null,
    title: "One candidate submit",
    requested_by: fixture.serviceUserId,
    status: "pending",
    priority: "normal",
    approval_group_id: "portable:run_portable_inbox",
    action_kind: "one_candidate_submit",
    target_account_ref_id: "auth:chrome-profile2",
    payload_hash: "f".repeat(64),
    policy_version: "automation_os_portable_external_approval_binding.v1",
    expires_at: "2030-01-01T00:00:00.000Z",
    decided_by_user_id: null,
    decision_revision: 1,
    consumed_at: null,
    consumed_by_attempt_id: null,
    resource_locks_json: "[]",
    created_at: now,
    decided_at: null,
    decision_note: null
  });

  const listed = approvals.listCompanyApprovals(fixture.companyId);
  assert.equal(listed.some((approval) => approval.id === "approval_portable_inbox"), true);
  assert.equal(listed.find((approval) => approval.id === "approval_portable_inbox")?.jobId, null);
  assert.equal(approvals.listBoundApprovals(fixture.companyId).some((approval) => approval.id === "approval_portable_inbox"), false);
  assert.equal(approvals.getBoundApproval(fixture.companyId, "approval_portable_inbox"), undefined);
});

test("approval consume requires an exact live attempt binding and succeeds once", () => {
  const fixture = seedFixture("company_approval_b", "owner_approval_b", "service_approval_b");
  const job = enqueue(fixture, "approval-consume-job");
  const approval = approvals.createBoundApproval({
    companyId: fixture.companyId,
    requestedByUserId: fixture.serviceUserId,
    jobId: job.id,
    title: "Bound action",
    actionKind: "publish.post",
    payloadHash: "c".repeat(64),
    policyVersion: "policy-v2",
    expiresAt: "2030-01-01T00:00:00.000Z",
    now: "2029-01-01T00:00:00.000Z"
  });
  const decided = approvals.decideBoundApproval({
    companyId: fixture.companyId,
    approvalId: approval.id,
    actorUserId: fixture.ownerUserId,
    decision: "approved",
    expectedRevision: 1,
    now: "2029-01-01T01:00:00.000Z"
  });
  const claim = queue.claimNextDurableJob({
    companyId: fixture.companyId,
    serviceUserId: fixture.serviceUserId,
    now: "2029-01-01T02:00:00.000Z",
    leaseMs: 60_000
  });
  assert.ok(claim);
  assert.throws(() => approvals.consumeBoundApproval({
    companyId: fixture.companyId,
    approvalId: decided.id,
    serviceUserId: fixture.serviceUserId,
    attemptId: claim.attemptId,
    fencingToken: claim.fencingToken,
    expectedDecisionRevision: 2,
    jobId: job.id,
    actionKind: "publish.changed",
    payloadHash: "c".repeat(64),
    policyVersion: "policy-v2",
    now: "2029-01-01T02:00:01.000Z"
  }), /approval_binding_mismatch/);

  assert.throws(() => approvals.consumeBoundApproval({
    companyId: fixture.companyId,
    approvalId: decided.id,
    serviceUserId: fixture.serviceUserId,
    attemptId: claim.attemptId,
    fencingToken: claim.fencingToken,
    expectedDecisionRevision: 2,
    jobId: job.id,
    actionKind: "publish.post",
    payloadHash: "c".repeat(64),
    policyVersion: "policy-v2",
    now: "2029-01-01T02:01:01.000Z"
  }), /approval_consume_conflict/);
  assert.equal(approvals.getBoundApproval(fixture.companyId, decided.id)?.consumedAt, null);

  const consumed = approvals.consumeBoundApproval({
    companyId: fixture.companyId,
    approvalId: decided.id,
    serviceUserId: fixture.serviceUserId,
    attemptId: claim.attemptId,
    fencingToken: claim.fencingToken,
    expectedDecisionRevision: 2,
    jobId: job.id,
    actionKind: "publish.post",
    payloadHash: "c".repeat(64),
    policyVersion: "policy-v2",
    now: "2029-01-01T02:00:01.000Z"
  });
  assert.equal(consumed.consumedByAttemptId, claim.attemptId);
  assert.equal(consumed.decisionRevision, 3);
  assert.throws(() => approvals.consumeBoundApproval({
    companyId: fixture.companyId,
    approvalId: decided.id,
    serviceUserId: fixture.serviceUserId,
    attemptId: claim.attemptId,
    fencingToken: claim.fencingToken,
    expectedDecisionRevision: 2,
    jobId: job.id,
    actionKind: "publish.post",
    payloadHash: "c".repeat(64),
    policyVersion: "policy-v2",
    now: "2029-01-01T02:00:02.000Z"
  }), /approval_not_consumable/);
});

test("revoked connection references cannot authorize approval consumption", () => {
  const fixture = seedFixture("company_approval_connection", "owner_approval_connection", "service_approval_connection");
  const connection = automations.saveCompanyConnectionRef({
    companyId: fixture.companyId,
    actorUserId: fixture.ownerUserId,
    connection: contracts.parseCompanyConnectionAccountRef({
      platform: "linkedin",
      account_ref: "company-page",
      status: "verified",
      scopes: ["post"],
      oauth_state: "connected",
      verification_status: "verified",
      last_verified_at: "2029-01-01T00:00:00.000Z",
      expires_at: "2030-01-01T00:00:00.000Z"
    })
  });
  const job = enqueue(fixture, "approval-revoked-connection-job");
  const approval = approvals.createBoundApproval({
    companyId: fixture.companyId,
    requestedByUserId: fixture.serviceUserId,
    jobId: job.id,
    title: "Bound connection action",
    actionKind: "publish.post",
    targetAccountRefId: connection.id,
    payloadHash: "d".repeat(64),
    policyVersion: "policy-v3",
    expiresAt: "2030-01-01T00:00:00.000Z",
    now: "2029-01-01T00:00:00.000Z"
  });
  const decided = approvals.decideBoundApproval({ companyId: fixture.companyId, approvalId: approval.id, actorUserId: fixture.ownerUserId, decision: "approved", expectedRevision: 1, now: "2029-01-01T01:00:00.000Z" });
  const claim = queue.claimNextDurableJob({ companyId: fixture.companyId, serviceUserId: fixture.serviceUserId, now: "2029-01-01T02:00:00.000Z", leaseMs: 60_000 });
  assert.ok(claim);
  automations.revokeCompanyConnectionRef({ companyId: fixture.companyId, actorUserId: fixture.ownerUserId, connectionId: connection.id, expectedRevision: 1 });
  assert.throws(() => approvals.consumeBoundApproval({
    companyId: fixture.companyId,
    approvalId: decided.id,
    serviceUserId: fixture.serviceUserId,
    attemptId: claim.attemptId,
    fencingToken: claim.fencingToken,
    expectedDecisionRevision: 2,
    jobId: job.id,
    actionKind: "publish.post",
    targetAccountRefId: connection.id,
    payloadHash: "d".repeat(64),
    policyVersion: "policy-v3",
    now: "2029-01-01T02:00:01.000Z"
  }), /approval_consume_conflict/);
  assert.equal(approvals.getBoundApproval(fixture.companyId, decided.id)?.consumedAt, null);
});

test("expired connection references cannot authorize approval consumption", () => {
  const fixture = seedFixture("company_approval_expiry", "owner_approval_expiry", "service_approval_expiry");
  const connection = automations.saveCompanyConnectionRef({
    companyId: fixture.companyId,
    actorUserId: fixture.ownerUserId,
    connection: contracts.parseCompanyConnectionAccountRef({
      platform: "linkedin",
      account_ref: "expiring-page",
      status: "verified",
      scopes: ["post"],
      oauth_state: "connected",
      verification_status: "verified",
      last_verified_at: "2028-12-31T00:00:00.000Z",
      expires_at: "2029-01-01T01:30:00.000Z"
    })
  });
  const job = enqueue(fixture, "approval-expired-connection-job");
  const approval = approvals.createBoundApproval({
    companyId: fixture.companyId,
    requestedByUserId: fixture.serviceUserId,
    jobId: job.id,
    title: "Expiring connection action",
    actionKind: "publish.post",
    targetAccountRefId: connection.id,
    payloadHash: "e".repeat(64),
    policyVersion: "policy-v3",
    expiresAt: "2030-01-01T00:00:00.000Z",
    now: "2029-01-01T00:00:00.000Z"
  });
  const decided = approvals.decideBoundApproval({ companyId: fixture.companyId, approvalId: approval.id, actorUserId: fixture.ownerUserId, decision: "approved", expectedRevision: 1, now: "2029-01-01T01:00:00.000Z" });
  const claim = queue.claimNextDurableJob({ companyId: fixture.companyId, serviceUserId: fixture.serviceUserId, now: "2029-01-01T02:00:00.000Z", leaseMs: 60_000 });
  assert.ok(claim);
  assert.throws(() => approvals.consumeBoundApproval({
    companyId: fixture.companyId,
    approvalId: decided.id,
    serviceUserId: fixture.serviceUserId,
    attemptId: claim.attemptId,
    fencingToken: claim.fencingToken,
    expectedDecisionRevision: 2,
    jobId: job.id,
    actionKind: "publish.post",
    targetAccountRefId: connection.id,
    payloadHash: "e".repeat(64),
    policyVersion: "policy-v3",
    now: "2029-01-01T02:00:01.000Z"
  }), /approval_consume_conflict/);
  assert.equal(approvals.getBoundApproval(fixture.companyId, decided.id)?.consumedAt, null);
});

function seedFixture(companyId: string, ownerUserId: string, serviceUserId: string) {
  db.initDb();
  const now = db.nowIso();
  for (const user of [
    { id: ownerUserId, kind: "human", provider: "test" },
    { id: serviceUserId, kind: "service", provider: "service" }
  ]) {
    db.insert("users", { id: user.id, auth_provider: user.provider, auth_subject: user.id, email: null, display_name: user.id, kind: user.kind, status: "active", created_at: now, updated_at: now });
  }
  db.insert("companies", { id: companyId, slug: companyId, name: companyId, status: "active", created_at: now, updated_at: now });
  db.insert("company_memberships", { id: `${companyId}_owner`, company_id: companyId, user_id: ownerUserId, role: "owner", status: "active", created_at: now, updated_at: now });
  db.insert("company_memberships", { id: `${companyId}_service`, company_id: companyId, user_id: serviceUserId, role: "operator", status: "active", created_at: now, updated_at: now });
  const automation = automations.createAutomationRecord({
    companyId,
    actorUserId: ownerUserId,
    definition: contracts.parseAutomationCreate({ automation_type: "test", name: `${companyId} automation`, description: "test", goal: "safe dry run", lane: "local", risk_level: "low", approval_policy: "required_before_external_action", worker_command_kind: "safe_local_demo", create_approval: true, builder_spec: {} })
  });
  return { companyId, ownerUserId, serviceUserId, automation };
}

function enqueue(fixture: ReturnType<typeof seedFixture>, key: string) {
  return queue.enqueueAutomationDryRun({ companyId: fixture.companyId, actorUserId: fixture.ownerUserId, automationId: fixture.automation.id, idempotencyKey: key });
}

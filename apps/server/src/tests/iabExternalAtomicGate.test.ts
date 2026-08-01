import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-iab-atomic-gate-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");
process.env.AUTOMATION_OS_IAB_CAPABILITY_SECRET = "test-only-iab-capability-secret-20260724-32-bytes";

const db = await import("../db/client.js");
const contracts = await import("../automations/contracts.js");
const automations = await import("../automations/repository.js");
const queue = await import("../runs/durableQueue.js");
const approvals = await import("../approvals/repository.js");
const { readTrustedRegisteredWorkflowManifestHash } = await import("../registeredWorkflows.js");
const { computeServiceReadinessEffectKey, readServiceReadinessEffect, transitionServiceReadinessEffect } = await import("../serviceReadiness/effectLedger.js");
const { createSqlBackedRootOwnedIabExternalAtomicGateV1 } = await import("../serviceReadiness/iabExternalAtomicGate.js");
const capabilityModule = await import("../serviceReadiness/iabExternalCapability.js");
const executor = await import("../serviceReadiness/iabExternalExecutor.js");

const now = "2029-01-01T01:00:00.000Z";
const nowMs = Date.parse(now);

const sha = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

type Fixture = ReturnType<typeof makeFixture>;

function makeFixture(label: string) {
  db.initDb();
  const companyId = `company_atomic_${label}`;
  const ownerUserId = `owner_atomic_${label}`;
  const serviceUserId = `service_atomic_${label}`;
  const timestamp = now;
  for (const user of [
    { id: ownerUserId, kind: "human", provider: "test" },
    { id: serviceUserId, kind: "service", provider: "service" }
  ]) {
    db.insert("users", {
      id: user.id,
      auth_provider: user.provider,
      auth_subject: user.id,
      email: null,
      display_name: user.id,
      kind: user.kind,
      status: "active",
      created_at: timestamp,
      updated_at: timestamp
    });
  }
  db.insert("companies", { id: companyId, slug: companyId, name: companyId, status: "active", created_at: timestamp, updated_at: timestamp });
  db.insert("company_memberships", { id: `${companyId}_owner`, company_id: companyId, user_id: ownerUserId, role: "owner", status: "active", created_at: timestamp, updated_at: timestamp });
  db.insert("company_memberships", { id: `${companyId}_service`, company_id: companyId, user_id: serviceUserId, role: "operator", status: "active", created_at: timestamp, updated_at: timestamp });

  const automation = automations.createAutomationRecord({
    companyId,
    actorUserId: ownerUserId,
    definition: contracts.parseAutomationCreate({
      automation_type: "atomic-gate-test",
      name: `${companyId} automation`,
      description: "synthetic atomic gate test",
      goal: "reserve exactly once",
      lane: "local",
      risk_level: "low",
      approval_policy: "required_before_external_action",
      worker_command_kind: "safe_local_demo",
      create_approval: true,
      builder_spec: {}
    })
  });
  const job = queue.enqueueAutomationDryRun({
    companyId,
    actorUserId: ownerUserId,
    automationId: automation.id,
    idempotencyKey: `atomic-gate-${label}`
  });
  const connection = automations.saveCompanyConnectionRef({
    companyId,
    actorUserId: ownerUserId,
    connection: contracts.parseCompanyConnectionAccountRef({
      platform: "linkedin",
      account_ref: `account-${label}`,
      status: "verified",
      scopes: ["post"],
      oauth_state: "connected",
      verification_status: "verified",
      last_verified_at: now,
      expires_at: "2030-01-01T00:00:00.000Z"
    })
  });
  const targetHash = sha(`target-${label}`);
  const payloadHash = sha(`payload-${label}`);
  const approval = approvals.createBoundApproval({
    companyId,
    requestedByUserId: serviceUserId,
    jobId: job.id,
    title: "Synthetic external action",
    actionKind: "publish.post",
    targetAccountRefId: connection.id,
    payloadHash,
    policyVersion: "policy-v1",
    expiresAt: "2030-01-01T00:00:00.000Z",
    now
  });
  const decided = approvals.decideBoundApproval({
    companyId,
    approvalId: approval.id,
    actorUserId: ownerUserId,
    decision: "approved",
    expectedRevision: 1,
    now: "2029-01-01T00:30:00.000Z"
  });
  const claim = queue.claimNextDurableJob({ companyId, serviceUserId, now, leaseMs: 60_000 });
  assert.ok(claim);

  const binding = {
    company_id: companyId,
    service_user_id: serviceUserId,
    issuer_service_user_id: serviceUserId,
    iab_generation: `generation-${label}`,
    iab_project_id: `project-${label}`,
    iab_thread_id: `thread-${label}`,
    job_id: job.id,
    action_kind: "publish.post",
    policy_version: "policy-v1",
    manifest_hash: readTrustedRegisteredWorkflowManifestHash("daily-ai") as string,
    root_id: `root-${label}`,
    workflow_id: "daily-ai",
    run_id: claim.runId,
    stage_id: "publish",
    attempt_id: claim.attemptId,
    fencing_token: claim.fencingToken,
    capability_id: `cap-${label}`,
    turn_id: `turn-${label}`,
    session_id: `session-${label}`,
    nonce: `nonce-${label}`,
    provider: "linkedin",
    account_ref: connection.id,
    target_hash: targetHash,
    payload_hash: payloadHash,
    effect_key: computeServiceReadinessEffectKey({
      company_id: companyId,
      provider: "linkedin",
      account_ref: connection.id,
      target_hash: targetHash,
      payload_hash: payloadHash,
      effect_class: "external_non_idempotent"
    }),
    approval_id: decided.id,
    approval_revision: decided.decisionRevision,
    approval_payload_hash: payloadHash
  } as const;

  const capabilityUnsigned = {
    schema: "service_readiness_iab_external_capability.v1" as const,
    surface: "in_app_browser" as const,
    company_id: companyId,
    root_id: binding.root_id,
    issuer_service_user_id: binding.issuer_service_user_id,
    manifest_hash: binding.manifest_hash,
    workflow_id: binding.workflow_id,
    run_id: binding.run_id,
    stage_id: binding.stage_id,
    attempt_id: binding.attempt_id,
    fencing_token: binding.fencing_token,
    capability_id: binding.capability_id,
    turn_id: binding.turn_id,
    session_id: binding.session_id,
    nonce: binding.nonce,
    iab_identity: {
      generation: `generation-${label}`,
      project_id: `project-${label}`,
      thread_id: `thread-${label}`,
      session_id: binding.session_id,
      turn_id: binding.turn_id,
      nonce: binding.nonce,
      stage: binding.stage_id,
      attempt: binding.fencing_token
    },
    capability_mode: "external" as const,
    effect_class: "external_non_idempotent" as const,
    effect_key: binding.effect_key,
    provider: binding.provider,
    account_ref: binding.account_ref,
    target_hash: binding.target_hash,
    payload_hash: binding.payload_hash,
    approval_id: binding.approval_id,
    approval_revision: binding.approval_revision,
    approval_payload_hash: binding.approval_payload_hash,
    issued_at: "2029-01-01T00:59:00.000Z",
    expires_at: "2029-01-01T01:04:00.000Z",
    external_action_executed: false as const,
    legacy_surfaces_forbidden: true as const,
    prior_receipt_reuse: false as const
  };
  const capability = capabilityModule.signIabExternalCapabilityV1(capabilityUnsigned);

  const request = {
    ...binding,
    surface: "in_app_browser" as const,
    capability_mode: "external" as const,
    effect_class: "external_non_idempotent" as const,
    external_action_executed: false as const,
    legacy_surfaces_forbidden: true as const,
    prior_receipt_reuse: false as const
  };

  const gate = createSqlBackedRootOwnedIabExternalAtomicGateV1({ now_ms: nowMs });
  return { companyId, ownerUserId, serviceUserId, job, connection, approval: decided, claim, binding, capability, request, gate };
}

function snapshot(fixture: Fixture) {
  return {
    approval: approvals.getBoundApproval(fixture.companyId, fixture.approval.id),
    effect: readServiceReadinessEffect(fixture.binding.effect_key, fixture.companyId)
  };
}

function expectNoMutation(fixture: Fixture, action: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  const before = snapshot(fixture);
  return action().then(
    () => assert.fail("expected atomic gate rejection"),
    (error: unknown) => {
      assert.match(error instanceof Error ? error.message : String(error), pattern);
      assert.deepEqual(snapshot(fixture), before);
    }
  );
}

test("atomic reserve consumes approval and inserts one running ledger row with readback", async () => {
  const fixture = makeFixture("commit");
  await fixture.gate.assertApproval(fixture.binding);
  const reservation = await fixture.gate.reserveAndConsume({
    binding: fixture.binding,
    capability: fixture.capability,
    request: fixture.request
  });
  assert.match(reservation.reservation_id, /^iab_reservation_[a-f0-9]{32}$/);
  assert.match(reservation.reservation_token, /^[a-f0-9]{64}$/);
  assert.equal(reservation.effect_key, fixture.binding.effect_key);
  assert.equal(reservation.approval_consumed, true);
  assert.equal(reservation.ledger_reserved, true);
  const approvalAfter = approvals.getBoundApproval(fixture.companyId, fixture.approval.id);
  assert.equal(approvalAfter?.consumedByAttemptId, fixture.binding.attempt_id);
  assert.equal(approvalAfter?.decisionRevision, fixture.binding.approval_revision + 1);
  const effect = readServiceReadinessEffect(fixture.binding.effect_key, fixture.companyId);
  assert.equal(effect?.status, "running");
  assert.equal(effect?.external_action_executed, false);
  assert.equal(effect?.attempt_id, fixture.binding.attempt_id);
  assert.throws(
    () => readServiceReadinessEffect(fixture.binding.effect_key),
    /service_readiness_external_company_required/
  );
});

test("stale, expired, tenant, action, payload, policy, and capability mismatches never mutate", async () => {
  const stale = makeFixture("stale");
  db.runSqlTransaction([{
    sql: `UPDATE durable_job_attempts SET status='finished' WHERE id=${db.sqlValue(stale.binding.attempt_id)} AND company_id=${db.sqlValue(stale.companyId)}`,
    expectChanges: 1
  }]);
  await expectNoMutation(stale, () => stale.gate.reserveAndConsume({ binding: stale.binding, capability: stale.capability, request: stale.request }), /iab_external_live_attempt_lease_binding_mismatch/);

  const expired = makeFixture("expired");
  const expiredCapability = { ...expired.capability, expires_at: "2029-01-01T00:59:59.000Z" };
  await expectNoMutation(expired, () => expired.gate.reserveAndConsume({ binding: expired.binding, capability: expiredCapability, request: expired.request }), /iab_external_capability_expired/);

  const tenant = makeFixture("tenant");
  const tenantBinding = { ...tenant.binding, company_id: "foreign-company" };
  await expectNoMutation(tenant, () => tenant.gate.reserveAndConsume({ binding: tenantBinding, capability: tenant.capability, request: { ...tenant.request, company_id: "foreign-company" } }), /company_scope_forbidden|iab_external_approval_readback_not_found|iab_external_capability_binding_mismatch/);

  const action = makeFixture("action");
  const actionBinding = { ...action.binding, action_kind: "delete.post" };
  await expectNoMutation(action, () => action.gate.reserveAndConsume({ binding: actionBinding, capability: action.capability, request: { ...action.request, action_kind: "delete.post" } }), /iab_external_approval_binding_mismatch/);

  const payload = makeFixture("payload");
  const payloadBinding = { ...payload.binding, payload_hash: sha("foreign-payload") };
  await expectNoMutation(payload, () => payload.gate.reserveAndConsume({ binding: payloadBinding, capability: payload.capability, request: { ...payload.request, payload_hash: payloadBinding.payload_hash } }), /iab_external_atomic_effect_key_binding_mismatch|iab_external_capability_binding_mismatch|iab_external_approval_payload_hash_mismatch/);

  const policy = makeFixture("policy");
  const policyBinding = { ...policy.binding, policy_version: "policy-foreign" };
  await expectNoMutation(policy, () => policy.gate.reserveAndConsume({ binding: policyBinding, capability: policy.capability, request: { ...policy.request, policy_version: policyBinding.policy_version } }), /iab_external_approval_binding_mismatch/);

  const capability = makeFixture("capability");
  const { capability_mac: _capabilityMac, ...unsignedCapability } = capability.capability;
  const badCapability = capabilityModule.signIabExternalCapabilityV1({ ...unsignedCapability, root_id: "foreign-root" });
  await expectNoMutation(capability, () => capability.gate.reserveAndConsume({ binding: capability.binding, capability: badCapability, request: capability.request }), /iab_external_capability_binding_mismatch:root_id/);
});

test("request comparison covers every binding field and never consumes on mismatch", async () => {
  const fields = ["company_id", "service_user_id", "issuer_service_user_id", "iab_generation", "iab_project_id", "iab_thread_id", "job_id", "action_kind", "policy_version", "manifest_hash", "root_id", "workflow_id", "run_id", "stage_id", "attempt_id", "fencing_token", "capability_id", "turn_id", "session_id", "nonce", "provider", "account_ref", "target_hash", "payload_hash", "effect_key", "approval_id", "approval_revision", "approval_payload_hash"] as const;
  for (const field of fields) {
    const fixture = makeFixture(`request-${field}`);
    const value = typeof fixture.request[field] === "number" ? Number(fixture.request[field]) + 1 : `${fixture.request[field]}-foreign`;
    const request = { ...fixture.request, [field]: value };
    await expectNoMutation(fixture, () => fixture.gate.reserveAndConsume({ binding: fixture.binding, capability: fixture.capability, request }), new RegExp(`iab_external_atomic_request_binding_mismatch:${field}`));
  }
  const flags = [
    ["surface", "legacy"],
    ["capability_mode", "read_only"],
    ["effect_class", "internal_idempotent"],
    ["external_action_executed", true],
    ["legacy_surfaces_forbidden", false],
    ["prior_receipt_reuse", true]
  ] as const;
  for (const [field, value] of flags) {
    const fixture = makeFixture(`request-flag-${field}`);
    const request = { ...fixture.request, [field]: value };
    await expectNoMutation(fixture, () => fixture.gate.reserveAndConsume({ binding: fixture.binding, capability: fixture.capability, request }), /iab_external_atomic_request_binding_mismatch/);
  }
});

test("replay and cross-binding reservations are rejected without additional mutation", async () => {
  const replay = makeFixture("replay");
  const first = await replay.gate.reserveAndConsume({ binding: replay.binding, capability: replay.capability, request: replay.request });
  const afterFirst = snapshot(replay);
  await assert.rejects(() => replay.gate.reserveAndConsume({ binding: replay.binding, capability: replay.capability, request: replay.request }), /iab_external_approval_not_consumable|iab_external_effect_replay_forbidden/);
  assert.deepEqual(snapshot(replay), afterFirst);
  assert.match(first.reservation_id, /^iab_reservation_[a-f0-9]{32}$/);
  assert.match(first.reservation_token, /^[a-f0-9]{64}$/);

  const cross = makeFixture("cross");
  db.insert("service_readiness_effect_ledger", {
    effect_key: cross.binding.effect_key,
    company_id: cross.companyId,
    reservation_id: "iab_reservation_foreign_cross_binding",
    reservation_token_hash: sha("foreign-reservation-token"),
    root_id: "foreign-root",
    workflow_id: cross.binding.workflow_id,
    run_id: cross.binding.run_id,
    stage_id: cross.binding.stage_id,
    attempt_id: cross.binding.attempt_id,
    fencing_token: cross.binding.fencing_token,
    provider: cross.binding.provider,
    account_ref: cross.binding.account_ref,
    target_hash: cross.binding.target_hash,
    payload_hash: cross.binding.payload_hash,
    effect_class: "external_non_idempotent",
    status: "running",
    external_action_executed: 0,
    provider_receipt_hash: null,
    cleanup_receipt_hash: null,
    exact_blocker: null,
    safe_resume_step: null,
    created_at: now,
    updated_at: now,
    terminal_at: null
  });
  await expectNoMutation(cross, () => cross.gate.reserveAndConsume({ binding: cross.binding, capability: cross.capability, request: cross.request }), /iab_external_effect_binding_mismatch/);
});

test("live lease and verified account checks gate mutation", async () => {
  const lease = makeFixture("lease");
  db.runSqlTransaction([{
    sql: `UPDATE durable_jobs SET lease_expires_at=${db.sqlValue("2029-01-01T00:59:59.000Z")} WHERE id=${db.sqlValue(lease.binding.job_id)} AND company_id=${db.sqlValue(lease.companyId)}`,
    expectChanges: 1
  }]);
  await expectNoMutation(lease, () => lease.gate.assertApproval(lease.binding), /iab_external_live_attempt_lease_binding_mismatch/);

  const account = makeFixture("account");
  db.runSqlTransaction([{
    sql: `UPDATE company_connection_account_refs SET status='revoked', verification_status='unverified', revoked_at=${db.sqlValue(now)} WHERE id=${db.sqlValue(account.binding.account_ref)} AND company_id=${db.sqlValue(account.companyId)}`,
    expectChanges: 1
  }]);
  await expectNoMutation(account, () => account.gate.assertApproval(account.binding), /iab_external_account_binding_invalid/);
});

test("transition requires derived reservation id and records verified cleanup", async () => {
  const fixture = makeFixture("transition");
  const reservation = await fixture.gate.reserveAndConsume({ binding: fixture.binding, capability: fixture.capability, request: fixture.request });
  assert.throws(() => transitionServiceReadinessEffect({
    company_id: fixture.companyId,
    capability_id: fixture.binding.capability_id,
    approval_id: fixture.binding.approval_id,
    approval_revision: fixture.binding.approval_revision,
    reservation_id: reservation.reservation_id,
    reservation_token_hash: sha(reservation.reservation_token),
    root_id: fixture.binding.root_id,
    workflow_id: fixture.binding.workflow_id,
    run_id: fixture.binding.run_id,
    stage_id: fixture.binding.stage_id,
    attempt_id: fixture.binding.attempt_id,
    fencing_token: fixture.binding.fencing_token,
    effect_key: fixture.binding.effect_key,
    status: "failed",
    external_action_executed: false,
    provider_receipt_hash: null,
    cleanup_receipt_hash: sha("legacy-cleanup"),
    exact_blocker: "legacy-bypass",
    safe_resume_step: "stop"
  } as never), /service_readiness_external_atomic_gate_required/);
  await assert.rejects(() => fixture.gate.transition({
    binding: fixture.binding,
    reservation: { ...reservation, reservation_id: "iab_reservation_foreign" },
    status: "succeeded",
    external_action_executed: false,
    provider_receipt_hash: null,
    cleanup_receipt_hash: sha("cleanup"),
    exact_blocker: null,
    safe_resume_step: null
  }), /iab_external_atomic_reservation_binding_invalid/);
  assert.equal(readServiceReadinessEffect(fixture.binding.effect_key, fixture.companyId)?.status, "running");

  await fixture.gate.transition({
    binding: fixture.binding,
    reservation,
    status: "failed",
    external_action_executed: false,
    provider_receipt_hash: null,
    cleanup_receipt_hash: sha("cleanup"),
    exact_blocker: "synthetic_provider_rejected",
    safe_resume_step: "review_synthetic_result"
  });
  const transitioned = readServiceReadinessEffect(fixture.binding.effect_key, fixture.companyId);
  assert.equal(transitioned?.status, "failed");
  assert.equal(transitioned?.cleanup_receipt_hash, sha("cleanup"));
  await assert.rejects(() => fixture.gate.transition({
    binding: fixture.binding,
    reservation,
    status: "failed",
    external_action_executed: false,
    provider_receipt_hash: null,
    cleanup_receipt_hash: sha("cleanup-2"),
    exact_blocker: "replay",
    safe_resume_step: "stop"
  }), /service_readiness_effect_terminal_transition_forbidden/);
});

test("external reservation fails closed when the trusted manifest digest mismatches", async () => {
  const fixture = makeFixture("manifest-readback");
  const untrustedGate = createSqlBackedRootOwnedIabExternalAtomicGateV1({ now_ms: nowMs });
  const badManifestHash = sha("caller-controlled-manifest");
  const badBinding = { ...fixture.binding, manifest_hash: badManifestHash };
  const { capability_mac: _capabilityMac, ...unsignedCapability } = fixture.capability;
  const badCapability = capabilityModule.signIabExternalCapabilityV1({ ...unsignedCapability, manifest_hash: badManifestHash });
  const badRequest = { ...fixture.request, manifest_hash: badManifestHash };
  await assert.rejects(() => untrustedGate.reserveAndConsume({
    binding: badBinding,
    capability: badCapability,
    request: badRequest
  }), /iab_external_trusted_manifest_hash_mismatch/);
  assert.equal(approvals.getBoundApproval(fixture.companyId, fixture.approval.id)?.consumedByAttemptId, null);
  assert.equal(readServiceReadinessEffect(fixture.binding.effect_key, fixture.companyId), undefined);
});

test("terminal transition rechecks the consumed approval revision in the same transaction", async () => {
  const fixture = makeFixture("approval-recheck");
  const reservation = await fixture.gate.reserveAndConsume({ binding: fixture.binding, capability: fixture.capability, request: fixture.request });
  db.runSqlTransaction([{
    sql: `UPDATE approvals SET decision_revision=decision_revision+1 WHERE id=${db.sqlValue(fixture.approval.id)} AND company_id=${db.sqlValue(fixture.companyId)}`,
    expectChanges: 1
  }]);
  await assert.rejects(() => fixture.gate.transition({
    binding: fixture.binding,
    reservation,
    status: "failed",
    external_action_executed: false,
    provider_receipt_hash: null,
    cleanup_receipt_hash: sha("approval-recheck-cleanup"),
    exact_blocker: "synthetic_provider_rejected",
    safe_resume_step: "review_synthetic_result"
  }), /service_readiness_external_approval_consumption_invalid/);
  assert.equal(readServiceReadinessEffect(fixture.binding.effect_key, fixture.companyId)?.status, "running");
});

test("capability parser and gate share deterministic TTL clock", () => {
  const fixture = makeFixture("clock");
  const result = capabilityModule.validateIabExternalCapabilityV1(fixture.capability, nowMs);
  assert.equal(result.ok, true);
  const expired = capabilityModule.validateIabExternalCapabilityV1(fixture.capability, Date.parse("2029-01-01T01:04:00.000Z"));
  assert.deepEqual(expired, { ok: false, status: "blocked", exact_blocker: "iab_external_capability_expired" });
});

void executor;

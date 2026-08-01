import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-automation-repository-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");

const db = await import("../db/client.js");
const contracts = await import("../automations/contracts.js");
const repository = await import("../automations/repository.js");

const { parseAutomationCreate, parseAutomationPatch, parseAutomationSchedule, parseCompanyConnectionAccountRef, parseCompanyMemory } = contracts;
const {
  archiveAutomationRecord,
  createAutomationRecord,
  getAutomationRecord,
  listAutomationRecords,
  listAutomationSchedules,
  listCompanyConnectionRefs,
  listCompanyMemory,
  requestCompanyConnectionReconnect,
  revokeCompanyConnectionRef,
  saveAutomationSchedule,
  saveCompanyConnectionRef,
  saveCompanyMemory,
  setAutomationSchedulePaused,
  updateAutomationRecord
} = repository;

test("create returns immutable version 1 and writes the audit event", () => {
  const { companyId, actorUserId } = seedCompany("company_a", "user_a");
  const definition = parseAutomationCreate({
    automation_type: "daily-ai",
    name: "Draft automation",
    description: "Initial draft",
    goal: "Ship a local plan",
    lane: "local",
    risk_level: "high",
    approval_policy: "required_before_external_action",
    worker_command_kind: "safe_local_demo",
    create_approval: true,
    builder_spec: { steps: ["research", "draft"] }
  });

  const created = createAutomationRecord({ companyId, actorUserId, definition });

  assert.equal(created.revision, 1);
  assert.ok(created.currentVersionId.startsWith("automation_version_"));
  assert.equal(created.name, "Draft automation");
  assert.equal(created.description, "Initial draft");
  assert.deepEqual(created.builderSpec, { steps: ["research", "draft"] });
  assert.deepEqual(listAutomationRecords(companyId), [created]);
  assert.deepEqual(getAutomationRecord(companyId, created.id), created);
  assert.equal(versionCount(created.id), 1);
  assert.equal(auditCount(companyId, "automation.created"), 1);
});

test("idempotent create commits automation, version, audit, and receipt once", () => {
  const { companyId, actorUserId } = seedCompany("company_idem", "user_idem");
  const request = {
    automation_type: "daily-ai",
    name: "Idempotent automation",
    description: "Created once",
    goal: "Verify atomic replay",
    lane: "local",
    risk_level: "high",
    approval_policy: "required_before_external_action",
    worker_command_kind: "safe_local_demo",
    create_approval: true,
    builder_spec: { steps: ["draft"] }
  };
  const definition = parseAutomationCreate(request);
  const first = createAutomationRecord({ companyId, actorUserId, definition, idempotencyKey: "automation-create-0001", idempotencyRequest: request });
  const replay = createAutomationRecord({ companyId, actorUserId, definition, idempotencyKey: "automation-create-0001", idempotencyRequest: request });

  assert.equal(replay.id, first.id);
  assert.equal(versionCount(first.id), 1);
  assert.equal(auditCount(companyId, "automation.created"), 1);
  assert.equal(db.querySql<{ count: number }>(`SELECT count(*) AS count FROM mvp_idempotency_keys WHERE company_id=${db.sqlValue(companyId)} AND status='completed'`)[0].count, 1);
  assert.throws(
    () => createAutomationRecord({ companyId, actorUserId, definition: { ...definition, name: "Changed" }, idempotencyKey: "automation-create-0001", idempotencyRequest: { ...request, name: "Changed" } }),
    /idempotency_key_payload_conflict/
  );
});

test("partial update creates version 2 and preserves unspecified fields", () => {
  const { companyId, actorUserId } = seedCompany("company_b", "user_b");
  const created = createAutomationRecord({
    companyId,
    actorUserId,
    definition: parseAutomationCreate({
      automation_type: "daily-ai",
      name: "Draft automation",
      description: "Initial draft",
      goal: "Ship a local plan",
      lane: "local",
      risk_level: "high",
      approval_policy: "required_before_external_action",
      worker_command_kind: "safe_local_demo",
      create_approval: true,
      builder_spec: { steps: ["research", "draft"] }
    })
  });

  const updated = updateAutomationRecord({
    companyId,
    actorUserId,
    automationId: created.id,
    patch: parseAutomationPatch({ expected_revision: 1, name: "Updated name", goal: "Updated goal" })
  });

  assert.equal(updated.revision, 2);
  assert.equal(updated.name, "Updated name");
  assert.equal(updated.goal, "Updated goal");
  assert.equal(updated.description, "Initial draft");
  assert.equal(updated.lane, "local");
  assert.equal(updated.riskLevel, "high");
  assert.deepEqual(updated.builderSpec, { steps: ["research", "draft"] });
  assert.equal(versionCount(created.id), 2);
  const version2 = db.querySql<{ name: string; description: string; goal: string; lane: string; risk_level: string; builder_spec_json: string }>(
    "SELECT name, description, goal, lane, risk_level, builder_spec_json FROM mvp_automation_versions WHERE automation_id=" +
      db.sqlValue(created.id) +
      " AND revision=2 LIMIT 1"
  )[0];
  assert.deepEqual(version2, {
    name: "Updated name",
    description: "Initial draft",
    goal: "Updated goal",
    lane: "local",
    risk_level: "high",
    builder_spec_json: JSON.stringify({ steps: ["research", "draft"] })
  });
});

test("stale revision conflict leaves the automation and audit rows unchanged", () => {
  const { companyId, actorUserId } = seedCompany("company_c", "user_c");
  const created = createAutomationRecord({
    companyId,
    actorUserId,
    definition: parseAutomationCreate({
      automation_type: "daily-ai",
      name: "Draft automation",
      description: "Initial draft",
      goal: "Ship a local plan",
      lane: "local",
      risk_level: "high",
      approval_policy: "required_before_external_action",
      worker_command_kind: "safe_local_demo",
      create_approval: true,
      builder_spec: { steps: ["research", "draft"] }
    })
  });

  const beforeAutomation = getAutomationRecord(companyId, created.id);
  const beforeVersions = versionCount(created.id);
  const beforeAudits = auditCount(companyId, "automation.updated");

  assert.throws(
    () =>
      updateAutomationRecord({
        companyId,
        actorUserId,
        automationId: created.id,
        patch: parseAutomationPatch({ expected_revision: 999, name: "Wrong" })
      }),
    /automation_revision_conflict/
  );

  assert.deepEqual(getAutomationRecord(companyId, created.id), beforeAutomation);
  assert.equal(versionCount(created.id), beforeVersions);
  assert.equal(auditCount(companyId, "automation.updated"), beforeAudits);
});

test("soft archive marks the row archived and removes it from the active list", () => {
  const { companyId, actorUserId } = seedCompany("company_d", "user_d");
  const created = createAutomationRecord({
    companyId,
    actorUserId,
    definition: parseAutomationCreate({
      automation_type: "daily-ai",
      name: "Draft automation",
      description: "Initial draft",
      goal: "Ship a local plan",
      lane: "local",
      risk_level: "high",
      approval_policy: "required_before_external_action",
      worker_command_kind: "safe_local_demo",
      create_approval: true,
      builder_spec: { steps: ["research", "draft"] }
    })
  });
  saveAutomationSchedule({
    companyId,
    actorUserId,
    automationId: created.id,
    schedule: parseAutomationSchedule({ kind: "daily", expression: "09:00", timezone: "Asia/Tokyo", enabled: true, expected_revision: 1 })
  });

  const archived = archiveAutomationRecord({
    companyId,
    actorUserId,
    automationId: created.id,
    expectedRevision: 1
  });

  assert.equal(archived.status, "archived");
  assert.ok(archived.archivedAt);
  assert.deepEqual(listAutomationRecords(companyId), []);
  assert.equal(getAutomationRecord(companyId, created.id, true)?.status, "archived");
  assert.equal(listAutomationSchedules(companyId, created.id)[0]?.status, "paused");
  assert.equal(listAutomationSchedules(companyId, created.id)[0]?.enabled, false);
  assert.equal(auditCount(companyId, "automation.archived"), 1);
});

test("company isolation keeps A and B records separate", () => {
  const companyA = seedCompany("company_e", "user_e");
  const companyB = seedCompany("company_f", "user_f");

  const automationA = createAutomationRecord({
    companyId: companyA.companyId,
    actorUserId: companyA.actorUserId,
    definition: parseAutomationCreate({
      automation_type: "daily-ai",
      name: "Company A",
      description: "A draft",
      goal: "A only",
      lane: "local",
      risk_level: "high",
      approval_policy: "required_before_external_action",
      worker_command_kind: "safe_local_demo",
      create_approval: true,
      builder_spec: { company: "A" }
    })
  });
  const automationB = createAutomationRecord({
    companyId: companyB.companyId,
    actorUserId: companyB.actorUserId,
    definition: parseAutomationCreate({
      automation_type: "daily-ai",
      name: "Company B",
      description: "B draft",
      goal: "B only",
      lane: "local",
      risk_level: "high",
      approval_policy: "required_before_external_action",
      worker_command_kind: "safe_local_demo",
      create_approval: true,
      builder_spec: { company: "B" }
    })
  });

  assert.deepEqual(listAutomationRecords(companyA.companyId).map((row) => row.id), [automationA.id]);
  assert.deepEqual(listAutomationRecords(companyB.companyId).map((row) => row.id), [automationB.id]);
  assert.equal(getAutomationRecord(companyA.companyId, automationB.id), undefined);
  assert.equal(getAutomationRecord(companyB.companyId, automationA.id), undefined);
});

test("schedule save, pause, and resume persist and audit atomically", () => {
  const { companyId, actorUserId } = seedCompany("company_g", "user_g");
  const created = createAutomationRecord({
    companyId,
    actorUserId,
    definition: parseAutomationCreate({
      automation_type: "daily-ai",
      name: "Scheduled automation",
      description: "Schedule draft",
      goal: "Run on schedule",
      lane: "local",
      risk_level: "high",
      approval_policy: "required_before_external_action",
      worker_command_kind: "safe_local_demo",
      create_approval: true,
      builder_spec: { schedule: true }
    })
  });

  const saved = saveAutomationSchedule({
    companyId,
    actorUserId,
    automationId: created.id,
    schedule: parseAutomationSchedule({
      kind: "daily",
      expression: "09:00",
      timezone: "Asia/Tokyo",
      enabled: true,
      expected_revision: 1
    })
  });
  assert.equal(saved.revision, 1);
  assert.equal(saved.status, "active");
  assert.equal(saved.enabled, true);

  const paused = setAutomationSchedulePaused({
    companyId,
    actorUserId,
    automationId: created.id,
    scheduleId: saved.id,
    expectedRevision: saved.revision,
    paused: true
  });
  assert.equal(paused.revision, 2);
  assert.equal(paused.status, "paused");
  assert.equal(paused.enabled, false);
  assert.ok(paused.pausedAt);

  const resumed = setAutomationSchedulePaused({
    companyId,
    actorUserId,
    automationId: created.id,
    scheduleId: saved.id,
    expectedRevision: paused.revision,
    paused: false
  });
  assert.equal(resumed.revision, 3);
  assert.equal(resumed.status, "active");
  assert.equal(resumed.enabled, true);
  assert.equal(resumed.pausedAt, null);
  assert.equal(listAutomationSchedules(companyId, created.id).length, 1);
  assert.equal(auditCount(companyId, "automation.schedule_created"), 1);
  assert.equal(auditCount(companyId, "automation.schedule_paused"), 1);
  assert.equal(auditCount(companyId, "automation.schedule_resumed"), 1);
});

test("memory and connection refs persist revisions and audits", () => {
  const { companyId, actorUserId } = seedCompany("company_h", "user_h");

  const memory = saveCompanyMemory({
    companyId,
    actorUserId,
    memory: parseCompanyMemory({ key: "brand", kind: "brand", title: "Brand", body: "Calm and precise", expected_revision: null })
  });
  const memoryUpdated = saveCompanyMemory({
    companyId,
    actorUserId,
    memory: parseCompanyMemory({ key: "brand", kind: "brand", title: "Brand", body: "Calm, precise, and direct", expected_revision: 1 }, true)
  });
  assert.equal(memory.revision, 1);
  assert.equal(memoryUpdated.revision, 2);
  assert.equal(listCompanyMemory(companyId).length, 1);
  assert.equal(listCompanyMemory(companyId)[0].body, "Calm, precise, and direct");

  const ref = saveCompanyConnectionRef({
    companyId,
    actorUserId,
    connection: parseCompanyConnectionAccountRef({
      platform: "linkedin",
      account_ref: "workspace-account-1",
      status: "configured",
      scopes: ["read_profile"],
      expires_at: "2027-01-01T00:00:00Z",
      expected_revision: null
    })
  });
  const refUpdated = saveCompanyConnectionRef({
    companyId,
    actorUserId,
    connection: parseCompanyConnectionAccountRef({
      platform: "linkedin",
      account_ref: "workspace-account-1",
      status: "verified",
      scopes: ["read_profile", "write_post"],
      expires_at: "2027-06-01T00:00:00Z",
      oauth_state: "connected",
      verification_status: "verified",
      last_verified_at: "2027-01-01T00:00:00Z",
      expected_revision: 1
    }, true)
  });
  assert.equal(ref.revision, 1);
  assert.equal(refUpdated.revision, 2);
  assert.equal(listCompanyConnectionRefs(companyId).length, 1);
  assert.equal(listCompanyConnectionRefs(companyId)[0].status, "verified");
  assert.equal(listCompanyConnectionRefs(companyId)[0].scopes.length, 2);
  const reconnect = requestCompanyConnectionReconnect({ companyId, actorUserId, connectionId: refUpdated.id, expectedRevision: 2 });
  assert.equal(reconnect.status, "reconnect_required");
  assert.equal(reconnect.oauthState, "reauthorization_required");
  assert.ok(reconnect.reconnectRequestedAt);
  const revoked = revokeCompanyConnectionRef({ companyId, actorUserId, connectionId: reconnect.id, expectedRevision: 3 });
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.oauthState, "revoked");
  assert.ok(revoked.revokedAt);
  assert.equal(listCompanyConnectionRefs(companyId)[0].status, "revoked");
  assert.throws(() => saveCompanyConnectionRef({
    companyId,
    actorUserId,
    connection: parseCompanyConnectionAccountRef({
      platform: "linkedin",
      account_ref: "workspace-account-1",
      status: "verified",
      scopes: ["read_profile"],
      expires_at: "2030-01-01T00:00:00Z",
      oauth_state: "connected",
      verification_status: "verified",
      last_verified_at: "2029-01-01T00:00:00Z",
      expected_revision: 4
    }, true)
  }), /company_connection_ref_reconnect_action_required/);
  assert.ok(auditCount(companyId, "company_memory.created") >= 1);
  assert.ok(auditCount(companyId, "company_memory.updated") >= 1);
  assert.ok(auditCount(companyId, "company_connection.created") >= 1);
  assert.ok(auditCount(companyId, "company_connection.updated") >= 1);
  assert.ok(auditCount(companyId, "company_connection.reconnect_requested") >= 1);
  assert.ok(auditCount(companyId, "company_connection.revoked") >= 1);
});

test("audit insertion failure rolls back the resource mutation", () => {
  const { companyId, actorUserId } = seedCompany("company_i", "user_i");
  const created = createAutomationRecord({
    companyId,
    actorUserId,
    definition: parseAutomationCreate({
      automation_type: "daily-ai",
      name: "Rollback automation",
      description: "Rollback draft",
      goal: "Should not change on audit failure",
      lane: "local",
      risk_level: "high",
      approval_policy: "required_before_external_action",
      worker_command_kind: "safe_local_demo",
      create_approval: true,
      builder_spec: { rollback: true }
    })
  });

  const beforeAutomation = getAutomationRecord(companyId, created.id);
  const beforeVersions = versionCount(created.id);
  const beforeAudits = auditCount(companyId, "automation.updated");
  const originalNow = Date.now;
  const originalRandom = Math.random;
  try {
    Date.now = () => 1_700_000_000_000;
    Math.random = () => 0.123456789;
    const conflictingAuditId = db.makeId("audit");
    db.insert("company_audit_events", {
      id: conflictingAuditId,
      company_id: companyId,
      actor_user_id: actorUserId,
      action: "automation.updated",
      entity_type: "automation",
      entity_id: created.id,
      before_json: "{}",
      after_json: "{}",
      created_at: db.nowIso()
    });

    assert.throws(
      () =>
        updateAutomationRecord({
          companyId,
          actorUserId,
          automationId: created.id,
          patch: parseAutomationPatch({ expected_revision: 1, name: "Should rollback" })
        }),
      /UNIQUE|constraint|SQLITE_CONSTRAINT/
    );
  } finally {
    Date.now = originalNow;
    Math.random = originalRandom;
  }

  assert.deepEqual(getAutomationRecord(companyId, created.id), beforeAutomation);
  assert.equal(versionCount(created.id), beforeVersions);
  assert.equal(auditCount(companyId, "automation.updated"), beforeAudits + 1);
});

test("repository mutations reject nonmembers and revoked members before any write", () => {
  const { companyId, actorUserId } = seedCompany("company_scope_guard", "user_scope_owner");
  const intruderId = "user_scope_intruder";
  const timestamp = db.nowIso();
  db.insert("users", {
    id: intruderId,
    auth_provider: "legacy_operator_token",
    auth_subject: intruderId,
    email: null,
    display_name: intruderId,
    kind: "human",
    status: "active",
    created_at: timestamp,
    updated_at: timestamp
  });
  const definition = parseAutomationCreate({
    automation_type: "daily-ai",
    name: "Scoped automation",
    description: "Membership boundary",
    goal: "Reject foreign actors",
    lane: "local",
    risk_level: "high",
    approval_policy: "required_before_external_action",
    worker_command_kind: "safe_local_demo",
    create_approval: true,
    builder_spec: { scope: true }
  });
  const created = createAutomationRecord({ companyId, actorUserId, definition });
  const beforeVersions = versionCount(created.id);
  const beforeAudits = db.querySql<{ count: number }>(`SELECT count(*) AS count FROM company_audit_events WHERE company_id=${db.sqlValue(companyId)}`)[0].count;
  const beforeIdempotency = db.querySql<{ count: number }>(`SELECT count(*) AS count FROM mvp_idempotency_keys WHERE company_id=${db.sqlValue(companyId)}`)[0].count;

  assert.throws(
    () => createAutomationRecord({ companyId, actorUserId: intruderId, definition, idempotencyKey: "foreign-create" }),
    /company_scope_forbidden/
  );
  assert.throws(
    () => updateAutomationRecord({ companyId, actorUserId: intruderId, automationId: created.id, patch: parseAutomationPatch({ expected_revision: 1, name: "Foreign" }) }),
    /company_scope_forbidden/
  );
  assert.throws(
    () => archiveAutomationRecord({ companyId, actorUserId: intruderId, automationId: created.id, expectedRevision: 1 }),
    /company_scope_forbidden/
  );
  assert.throws(
    () => saveAutomationSchedule({ companyId, actorUserId: intruderId, automationId: created.id, schedule: parseAutomationSchedule({ kind: "daily", expression: "09:00", timezone: "Asia/Tokyo", enabled: true, expected_revision: 1 }) }),
    /company_scope_forbidden/
  );
  assert.throws(
    () => saveCompanyMemory({ companyId, actorUserId: intruderId, memory: parseCompanyMemory({ key: "foreign", kind: "custom", title: "Foreign", body: "No write", expected_revision: null }) }),
    /company_scope_forbidden/
  );
  assert.throws(
    () => saveCompanyConnectionRef({ companyId, actorUserId: intruderId, connection: parseCompanyConnectionAccountRef({ platform: "linkedin", account_ref: "foreign-ref", status: "configured", scopes: [], expires_at: null, expected_revision: null }) }),
    /company_scope_forbidden/
  );

  db.execSql(`UPDATE company_memberships SET status='revoked' WHERE company_id=${db.sqlValue(companyId)} AND user_id=${db.sqlValue(actorUserId)}`);
  assert.throws(
    () => saveCompanyMemory({ companyId, actorUserId, memory: parseCompanyMemory({ key: "revoked", kind: "custom", title: "Revoked", body: "No write", expected_revision: null }) }),
    /company_scope_forbidden/
  );

  assert.equal(versionCount(created.id), beforeVersions);
  assert.equal(db.querySql<{ count: number }>(`SELECT count(*) AS count FROM company_audit_events WHERE company_id=${db.sqlValue(companyId)}`)[0].count, beforeAudits);
  assert.equal(db.querySql<{ count: number }>(`SELECT count(*) AS count FROM mvp_idempotency_keys WHERE company_id=${db.sqlValue(companyId)}`)[0].count, beforeIdempotency);
  assert.equal(listAutomationSchedules(companyId, created.id).length, 0);
  assert.equal(listCompanyMemory(companyId).length, 0);
  assert.equal(listCompanyConnectionRefs(companyId).length, 0);
});

function seedCompany(companyId: string, actorUserId: string): { companyId: string; actorUserId: string } {
  db.initDb();
  const timestamp = db.nowIso();
  db.insert("users", {
    id: actorUserId,
    auth_provider: "legacy_operator_token",
    auth_subject: actorUserId,
    email: null,
    display_name: actorUserId,
    kind: "human",
    status: "active",
    created_at: timestamp,
    updated_at: timestamp
  });
  db.insert("companies", {
    id: companyId,
    slug: companyId,
    name: companyId,
    status: "active",
    created_at: timestamp,
    updated_at: timestamp
  });
  db.insert("company_memberships", {
    id: `${companyId}_membership`,
    company_id: companyId,
    user_id: actorUserId,
    role: "owner",
    status: "active",
    created_at: timestamp,
    updated_at: timestamp
  });
  return { companyId, actorUserId };
}

function versionCount(automationId: string): number {
  return db.querySql<{ count: number }>(
    `SELECT count(*) AS count FROM mvp_automation_versions WHERE automation_id=${db.sqlValue(automationId)}`
  )[0].count;
}

function auditCount(companyId: string, action: string): number {
  return db.querySql<{ count: number }>(
    `SELECT count(*) AS count FROM company_audit_events WHERE company_id=${db.sqlValue(companyId)} AND action=${db.sqlValue(action)}`
  )[0].count;
}

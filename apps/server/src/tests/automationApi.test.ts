import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-api-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");
process.env.NODE_TEST_CONTEXT = "1";
process.env.AUTOMATION_OS_OWNER_USER_ID = "api_bootstrap_owner";

const { app } = await import("../index.js");
const { execSql, initDb, querySql, sqlValue } = await import("../db/client.js");

initDb();

test("v1 automation reads are company-isolated and viewer/operator/admin permissions are enforced", async () => {
  seedMembership("api_company_a", "api_owner_a", "owner");
  seedMembership("api_company_b", "api_owner_b", "owner");
  seedMembership("api_company_roles", "api_viewer", "viewer");
  seedMembership("api_company_roles", "api_operator", "operator");
  seedMembership("api_company_roles", "api_admin", "admin");

  setActor("api_owner_a");
  const createdA = await createV1("api_company_a", "Company A automation", "api-isolation-a");
  setActor("api_owner_b");
  const createdB = await createV1("api_company_b", "Company B automation", "api-isolation-b");

  setActor("api_owner_a");
  const listA = await requestJson("GET", "/api/v1/companies/api_company_a/automations");
  assert.equal(listA.status, 200, listA.raw);
  assert.deepEqual(listA.json.automations.map((item: any) => item.id), [createdA.id]);
  assert.doesNotMatch(listA.raw, /Company B automation/);
  const forbiddenB = await requestJson("GET", "/api/v1/companies/api_company_b/automations");
  assert.equal(forbiddenB.status, 404, forbiddenB.raw);
  assert.equal(forbiddenB.json.error, "company_scope_forbidden");

  setActor("api_owner_b");
  const listB = await requestJson("GET", "/api/v1/companies/api_company_b/automations");
  assert.equal(listB.status, 200, listB.raw);
  assert.deepEqual(listB.json.automations.map((item: any) => item.id), [createdB.id]);
  assert.doesNotMatch(listB.raw, /Company A automation/);

  setActor("api_viewer");
  const viewerList = await requestJson("GET", "/api/v1/companies/api_company_roles/automations");
  assert.equal(viewerList.status, 200, viewerList.raw);
  const viewerMemory = await requestJson("GET", "/api/v1/companies/api_company_roles/memory");
  assert.equal(viewerMemory.status, 200, viewerMemory.raw);
  const viewerCreate = await requestJson(
    "POST",
    "/api/v1/companies/api_company_roles/automations",
    automationBody("Viewer must not create"),
    { "idempotency-key": "api-viewer-create" }
  );
  assert.equal(viewerCreate.status, 404, viewerCreate.raw);
  const viewerRefs = await requestJson("GET", "/api/v1/companies/api_company_roles/connection-account-refs");
  assert.equal(viewerRefs.status, 404, viewerRefs.raw);

  setActor("api_operator");
  const operatorAutomation = await createV1("api_company_roles", "Operator automation", "api-operator-create");
  const operatorPatch = await requestJson(
    "PATCH",
    `/api/v1/companies/api_company_roles/automations/${operatorAutomation.id}`,
    { name: "Operator automation updated", expected_revision: 1 }
  );
  assert.equal(operatorPatch.status, 200, operatorPatch.raw);
  assert.equal(operatorPatch.json.automation.revision, 2);
  const operatorSchedule = await requestJson(
    "PUT",
    `/api/v1/companies/api_company_roles/automations/${operatorAutomation.id}/schedule`,
    { kind: "daily", expression: "09:00", timezone: "Asia/Tokyo", enabled: true, expected_revision: 1 }
  );
  assert.equal(operatorSchedule.status, 200, operatorSchedule.raw);
  const operatorMemory = await requestJson(
    "PUT",
    "/api/v1/companies/api_company_roles/memory/operator-note",
    { kind: "custom", title: "Operator note", body: "Writable by operator" }
  );
  assert.equal(operatorMemory.status, 200, operatorMemory.raw);
  const operatorRefs = await requestJson(
    "PUT",
    "/api/v1/companies/api_company_roles/connection-account-refs/linkedin/operator-account",
    { status: "configured", scopes: ["post"] }
  );
  assert.equal(operatorRefs.status, 404, operatorRefs.raw);
  const operatorArchive = await requestJson(
    "DELETE",
    `/api/v1/companies/api_company_roles/automations/${operatorAutomation.id}`,
    undefined,
    { "if-match": "2" }
  );
  assert.equal(operatorArchive.status, 404, operatorArchive.raw);

  setActor("api_admin");
  const adminRef = await requestJson(
    "PUT",
    "/api/v1/companies/api_company_roles/connection-account-refs/linkedin/admin-account",
    { status: "verified", scopes: ["post", "read"], oauth_state: "connected", verification_status: "verified", last_verified_at: "2026-07-15T00:00:00.000Z", expires_at: "2030-01-01T00:00:00.000Z" }
  );
  assert.equal(adminRef.status, 200, adminRef.raw);
  const adminAutomation = await createV1("api_company_roles", "Admin automation", "api-admin-create");
  const adminArchive = await requestJson(
    "DELETE",
    `/api/v1/companies/api_company_roles/automations/${adminAutomation.id}`,
    undefined,
    { "if-match": "1" }
  );
  assert.equal(adminArchive.status, 200, adminArchive.raw);
  assert.equal(adminArchive.json.automation.status, "archived");
});

test("automation readback exposes the truthful scheduled dry-run contract", async () => {
  seedMembership("api_execution_contract", "api_execution_owner", "owner");
  setActor("api_execution_owner");

  const created = await createV1("api_execution_contract", "Execution contract", "api-execution-contract");
  const schedule = await requestJson(
    "PUT",
    `/api/v1/companies/api_execution_contract/automations/${created.id}/schedule`,
    { kind: "daily", expression: "09:00", timezone: "Asia/Tokyo", enabled: true, expected_revision: 1 }
  );
  assert.equal(schedule.status, 200, schedule.raw);

  const listed = await requestJson("GET", "/api/v1/companies/api_execution_contract/automations");
  assert.equal(listed.status, 200, listed.raw);
  const item = listed.json.automations.find((automation: any) => automation.id === created.id);
  assert.ok(item, listed.raw);
  assert.equal(item.execution_mode, "control_plane_dry_run");
  assert.equal(item.scheduler_effect, "queues_scheduled_dry_run");
  assert.equal(item.external_action_allowed, false);
  assert.match(item.execution_label, /dry-run/);
});

test("presentation profile is company-scoped and revisioned", async () => {
  setActor("api_owner_a");
  const initial = await requestJson("GET", "/api/v1/companies/api_company_a/presentation-profile");
  assert.equal(initial.status, 200, initial.raw);
  assert.equal(initial.json.profile.source, "derived_from_project_automation_catalog");

  const created = await requestJson("PUT", "/api/v1/companies/api_company_a/presentation-profile", {
    profile: {
      kind: "research",
      label: "週次調査",
      primaryMetrics: ["新規情報", "停止中"],
      widgets: ["kpi", "timeline", "failure_table"],
      preferredGrouping: "week",
      freshnessSlaMinutes: 120,
      explanation: "鮮度と停止理由を優先する"
    }
  });
  assert.equal(created.status, 200, created.raw);
  assert.equal(created.json.profile.source, "persisted_project_profile");
  assert.equal(created.json.revision, 1);

  const updated = await requestJson("PUT", "/api/v1/companies/api_company_a/presentation-profile", {
    expected_revision: 1,
    profile: { label: "月次調査" }
  });
  assert.equal(updated.status, 200, updated.raw);
  assert.equal(updated.json.revision, 2);
  assert.equal(updated.json.profile.label, "月次調査");

  const conflict = await requestJson("PUT", "/api/v1/companies/api_company_a/presentation-profile", {
    expected_revision: 1,
    profile: { label: "競合" }
  });
  assert.equal(conflict.status, 409, conflict.raw);

  setActor("api_owner_b");
  const forbidden = await requestJson("GET", "/api/v1/companies/api_company_a/presentation-profile");
  assert.equal(forbidden.status, 404, forbidden.raw);
});

test("registered automation readback is company-scoped and HTTP execution remains read-only", async () => {
  seedMembership("api_registered_company", "api_registered_owner", "owner");
  seedMembership("api_registered_other", "api_registered_other_owner", "owner");
  setActor("api_registered_owner");

  const readback = await requestJson("GET", "/api/mvp/registered-automations?project_id=api_registered_company");
  assert.equal(readback.status, 200, readback.raw);
  assert.equal(readback.json.project_id, "api_registered_company");
  assert.ok(readback.json.automation_count > 0, readback.raw);
  assert.equal(readback.json.external_action_executed, false);
  assert.equal(readback.json.automations[0].can_run, false);
  assert.equal(readback.json.automations[0].toml_ref, null);
  assert.doesNotMatch(readback.raw, /\/Users\//);

  const run = await requestJson(
    "POST",
    `/api/mvp/registered-automations/${encodeURIComponent(readback.json.automations[0].id)}/run?project_id=api_registered_company`,
    {}
  );
  assert.equal(run.status, 200, run.raw);
  assert.equal(run.json.read_only, true);
  assert.equal(run.json.external_action_executed, false);
  assert.match(run.json.exact_blocker, /registered_automation_/);

  setActor("api_registered_other_owner");
  const forbidden = await requestJson("GET", "/api/mvp/registered-automations?project_id=api_registered_company");
  assert.equal(forbidden.status, 403, forbidden.raw);
});

test("connection lifecycle is revisioned and Admin diagnostics are owner-only", async () => {
  setActor("api_admin");
  const inventory = await requestJson("GET", "/api/v1/companies/api_company_roles/connection-account-refs");
  assert.equal(inventory.status, 200, inventory.raw);
  const connection = inventory.json.refs.find((item: any) => item.accountRef === "admin-account");
  assert.ok(connection);

  const reconnect = await requestJson(
    "POST",
    `/api/v1/companies/api_company_roles/connection-account-refs/${connection.id}/reconnect`,
    { expected_revision: connection.revision }
  );
  assert.equal(reconnect.status, 200, reconnect.raw);
  assert.equal(reconnect.json.connection.status, "reconnect_required");
  assert.equal(reconnect.json.connection.oauthState, "reauthorization_required");
  assert.equal(reconnect.json.human_gate.reason, "oauth_reauthorization_required");
  assert.equal(reconnect.json.external_oauth_action_executed, false);

  const revoke = await requestJson(
    "POST",
    `/api/v1/companies/api_company_roles/connection-account-refs/${connection.id}/revoke`,
    { expected_revision: reconnect.json.connection.revision }
  );
  assert.equal(revoke.status, 200, revoke.raw);
  assert.equal(revoke.json.connection.status, "revoked");
  assert.equal(revoke.json.revocation_scope, "local_connection_reference");
  assert.equal(revoke.json.external_provider_revocation_executed, false);

  const adminDiagnostics = await requestJson("GET", "/api/v1/admin/diagnostics");
  assert.equal(adminDiagnostics.status, 403, adminDiagnostics.raw);
  assert.equal(adminDiagnostics.json.error, "owner_admin_required");
  const legacyAdminDiagnostics = await requestJson("GET", "/api/dashboard");
  assert.equal(legacyAdminDiagnostics.status, 403, legacyAdminDiagnostics.raw);

  setActor("api_operator");
  const operatorMutation = await requestJson(
    "POST",
    `/api/v1/companies/api_company_roles/connection-account-refs/${connection.id}/reconnect`,
    { expected_revision: revoke.json.connection.revision }
  );
  assert.equal(operatorMutation.status, 404, operatorMutation.raw);
  assert.equal(querySql<{ status: string }>(`SELECT status FROM company_connection_account_refs WHERE id=${sqlValue(connection.id)}`)[0].status, "revoked");

  setActor("api_owner_a");
  const ownerDiagnostics = await requestJson("GET", "/api/v1/admin/diagnostics");
  assert.equal(ownerDiagnostics.status, 200, ownerDiagnostics.raw);
  assert.equal(ownerDiagnostics.json.ok, true);
  assert.equal(ownerDiagnostics.json.external_action_executed, false);
  assert.ok(ownerDiagnostics.json.pc);
  assert.ok(ownerDiagnostics.json.browser);
  assert.ok(ownerDiagnostics.json.obsidian);
  assert.equal(ownerDiagnostics.json.company_release_readiness.status, "blocked");
  assert.equal(ownerDiagnostics.json.company_release_readiness.activation_authorized, false);
  assert.equal(ownerDiagnostics.json.company_release_evidence.status, "blocked");
  assert.equal(ownerDiagnostics.json.company_release_evidence.external_action_executed, false);
  assert.equal(ownerDiagnostics.json.company_release_evidence.incident_recovery_drill.status, "blocked");
  const ownerLegacyDiagnostics = await requestJson("GET", "/api/dashboard");
  assert.equal(ownerLegacyDiagnostics.status, 200, ownerLegacyDiagnostics.raw);
});

test("performance analytics is date-filtered, viewer-readable, and company-isolated", async () => {
  seedMembership("api_company_analytics_a", "api_analytics_owner_a", "owner");
  seedMembership("api_company_analytics_b", "api_analytics_owner_b", "owner");
  seedMembership("api_company_analytics_a", "api_analytics_viewer_a", "viewer");
  setActor("api_analytics_owner_a");
  const automationA = await createV1("api_company_analytics_a", "Analytics A", "api-analytics-create-a");
  const dryRun = await requestJson(
    "POST",
    `/api/v1/companies/api_company_analytics_a/automations/${automationA.id}/dry-runs`,
    {},
    { "idempotency-key": "api-analytics-job-a" }
  );
  assert.equal(dryRun.status, 202, dryRun.raw);
  execSql(`UPDATE durable_jobs SET status='completed', created_at='2026-07-10T00:00:00.000Z', updated_at='2026-07-10T00:01:00.000Z' WHERE id=${sqlValue(dryRun.json.job.id)}`);

  setActor("api_analytics_owner_b");
  const automationB = await createV1("api_company_analytics_b", "Analytics B", "api-analytics-create-b");

  setActor("api_analytics_viewer_a");
  const analytics = await requestJson("GET", "/api/v1/companies/api_company_analytics_a/analytics/performance?from=2026-07-01T00%3A00%3A00.000Z&to=2026-08-01T00%3A00%3A00.000Z");
  assert.equal(analytics.status, 200, analytics.raw);
  assert.equal(analytics.json.company_id, "api_company_analytics_a");
  assert.equal(analytics.json.metrics.outcome.denominator, 1);
  assert.equal(analytics.json.metrics.outcome.numerator, 1);
  assert.equal(analytics.json.data_state, "partial");
  assert.equal(analytics.json.external_action_executed, false);
  assert.doesNotMatch(analytics.raw, /Analytics B/);

  const foreignCompany = await requestJson("GET", "/api/v1/companies/api_company_analytics_b/analytics/performance");
  assert.equal(foreignCompany.status, 404, foreignCompany.raw);
  const foreignAutomation = await requestJson("GET", `/api/v1/companies/api_company_analytics_a/analytics/performance?automation_id=${encodeURIComponent(automationB.id)}`);
  assert.equal(foreignAutomation.status, 404, foreignAutomation.raw);
  const invalidRange = await requestJson("GET", "/api/v1/companies/api_company_analytics_a/analytics/performance?from=2026-08-01T00%3A00%3A00.000Z&to=2026-07-01T00%3A00%3A00.000Z");
  assert.equal(invalidRange.status, 400, invalidRange.raw);
  assert.equal(invalidRange.json.error, "analytics_range_invalid");
});

test("idempotent create, optimistic revision checks, legacy adapters, and builder writes share one version history", async () => {
  seedMembership("api_company_versions", "api_version_owner", "owner");
  setActor("api_version_owner");

  const body = automationBody("Versioned automation");
  const first = await requestJson(
    "POST",
    "/api/v1/companies/api_company_versions/automations",
    body,
    { "idempotency-key": "api-version-create" }
  );
  assert.equal(first.status, 201, first.raw);
  const automationId = first.json.automation.id as string;
  const firstVersionId = first.json.automation.current_version_id as string;

  const replay = await requestJson(
    "POST",
    "/api/v1/companies/api_company_versions/automations",
    body,
    { "idempotency-key": "api-version-create" }
  );
  assert.equal(replay.status, 201, replay.raw);
  assert.equal(replay.json.automation.id, automationId);
  assert.equal(replay.json.automation.current_version_id, firstVersionId);
  assert.equal(replay.json.automation.revision, 1);
  assert.equal(countRows("mvp_automations", `id=${sqlValue(automationId)}`), 1);
  assert.equal(countRows("mvp_automation_versions", `automation_id=${sqlValue(automationId)}`), 1);
  assert.equal(countRows("mvp_idempotency_keys", "idempotency_key='api-version-create'"), 1);

  const payloadConflict = await requestJson(
    "POST",
    "/api/v1/companies/api_company_versions/automations",
    { ...body, name: "Different payload" },
    { "idempotency-key": "api-version-create" }
  );
  assert.equal(payloadConflict.status, 409, payloadConflict.raw);
  assert.equal(payloadConflict.json.error, "idempotency_key_payload_conflict");

  const legacyPatch = await requestJson(
    "PATCH",
    `/api/mvp/automations/${automationId}`,
    { company_id: "api_company_versions", name: "Updated through legacy", expected_revision: 1 }
  );
  assert.equal(legacyPatch.status, 200, legacyPatch.raw);
  assert.equal(legacyPatch.json.automation.revision, 2);

  const v1Patch = await requestJson(
    "PATCH",
    `/api/v1/companies/api_company_versions/automations/${automationId}`,
    { goal: "Updated through v1", expected_revision: 2 }
  );
  assert.equal(v1Patch.status, 200, v1Patch.raw);
  assert.equal(v1Patch.json.automation.revision, 3);

  const versionsBeforeStale = countRows("mvp_automation_versions", `automation_id=${sqlValue(automationId)}`);
  const stale = await requestJson(
    "PATCH",
    `/api/v1/companies/api_company_versions/automations/${automationId}`,
    { name: "Stale overwrite", expected_revision: 1 }
  );
  assert.equal(stale.status, 409, stale.raw);
  assert.equal(stale.json.error, "automation_revision_conflict");
  assert.equal(countRows("mvp_automation_versions", `automation_id=${sqlValue(automationId)}`), versionsBeforeStale);

  const revisions = querySql<{ revision: number }>(
    `SELECT revision FROM mvp_automation_versions WHERE automation_id=${sqlValue(automationId)} ORDER BY revision`
  ).map((row) => Number(row.revision));
  assert.deepEqual(revisions, [1, 2, 3]);

  const v1Read = await requestJson("GET", `/api/v1/companies/api_company_versions/automations/${automationId}`);
  const legacyRead = await requestJson("GET", "/api/mvp/automations?company_id=api_company_versions");
  assert.equal(v1Read.status, 200, v1Read.raw);
  assert.equal(legacyRead.status, 200, legacyRead.raw);
  const legacyCurrent = legacyRead.json.automations.find((item: any) => item.id === automationId);
  assert.equal(legacyCurrent.revision, v1Read.json.automation.revision);
  assert.equal(legacyCurrent.current_version_id, v1Read.json.automation.current_version_id);
  assert.equal(legacyCurrent.name, "Updated through legacy");
  assert.equal(legacyCurrent.goal, "Updated through v1");

  const versionCountBeforeBuilder = countRows("mvp_automation_versions", `automation_id=${sqlValue(automationId)}`);
  const auditCountBeforeBuilder = countRows(
    "company_audit_events",
    `entity_id=${sqlValue(automationId)} AND action='automation.updated'`
  );
  const builder = await requestJson(
    "PUT",
    `/api/mvp/automations/${automationId}/builder-spec`,
    { spec: { steps: [{ kind: "draft" }, { kind: "approve" }] } },
    { "if-match": "3" }
  );
  assert.equal(builder.status, 200, builder.raw);
  assert.equal(builder.json.automation.revision, 4);
  assert.deepEqual(builder.json.spec, { steps: [{ kind: "draft" }, { kind: "approve" }] });
  assert.equal(countRows("mvp_automation_versions", `automation_id=${sqlValue(automationId)}`), versionCountBeforeBuilder + 1);
  assert.equal(
    countRows("company_audit_events", `entity_id=${sqlValue(automationId)} AND action='automation.updated'`),
    auditCountBeforeBuilder + 1
  );
  assert.deepEqual(
    querySql<{ revision: number; builder_spec_json: string }>(
      `SELECT revision, builder_spec_json FROM mvp_automations WHERE id=${sqlValue(automationId)}`
    ).map((row) => ({ revision: Number(row.revision), spec: JSON.parse(row.builder_spec_json) })),
    [{ revision: 4, spec: { steps: [{ kind: "draft" }, { kind: "approve" }] } }]
  );
});

test("state reload includes schedules, memory, and account refs, and archive pauses the schedule", async () => {
  seedMembership("api_company_state", "api_state_admin", "admin");
  setActor("api_state_admin");
  const automation = await createV1("api_company_state", "State reload automation", "api-state-create");

  const schedule = await requestJson(
    "PUT",
    `/api/v1/companies/api_company_state/automations/${automation.id}/schedule`,
    { kind: "weekly", expression: "MON 09:00", timezone: "Asia/Tokyo", enabled: true, expected_revision: 1 }
  );
  assert.equal(schedule.status, 200, schedule.raw);
  assert.equal(schedule.json.schedule.status, "active");
  assert.ok(Number.isFinite(Date.parse(schedule.json.schedule.nextRunAt)), schedule.raw);

  const memory = await requestJson(
    "PUT",
    "/api/v1/companies/api_company_state/memory/brand-voice",
    { kind: "brand", title: "Brand voice", body: "Calm and precise" }
  );
  assert.equal(memory.status, 200, memory.raw);

  const accountRef = await requestJson(
    "PUT",
    "/api/v1/companies/api_company_state/connection-account-refs/linkedin/company-page",
    { status: "verified", scopes: ["read", "post"], oauth_state: "connected", verification_status: "verified", last_verified_at: "2026-07-15T00:00:00.000Z", expires_at: "2030-01-01T00:00:00.000Z" }
  );
  assert.equal(accountRef.status, 200, accountRef.raw);
  assert.equal(accountRef.json.secret_material_included, false);

  const state = await requestJson("GET", "/api/mvp/state?company_id=api_company_state");
  assert.equal(state.status, 200, state.raw);
  assert.deepEqual(state.json.company_scope.company_ids, ["api_company_state"]);
  assert.equal(state.json.sync_readback.schema, "mvp_sync_readback.v1");
  assert.deepEqual(state.json.sync_readback.company_ids, ["api_company_state"]);
  assert.equal(state.json.sync_readback.automation_count, state.json.automations.length);
  assert.equal(state.json.sync_readback.registered_workflow_count, state.json.registered_workflow_ids.length);
  assert.equal(state.json.sync_readback.runs_count, state.json.runs.length);
  assert.ok(typeof state.json.sync_readback.captured_at === "string");
  assert.equal("deployment" in state.json, false);
  assert.equal("productionGuard" in state.json, false);
  assert.equal("accessGuard" in state.json, false);
  assert.equal("audit_events" in state.json, false);
  assert.ok(state.json.schedules.some((item: any) => item.automationId === automation.id && item.status === "active"));
  assert.ok(state.json.project_memory.some((item: any) => item.key === "brand-voice" && item.body === "Calm and precise"));
  assert.equal("account_refs" in state.json, false);
  const connectionInventory = await requestJson("GET", "/api/v1/companies/api_company_state/connection-account-refs");
  assert.equal(connectionInventory.status, 200, connectionInventory.raw);
  assert.ok(connectionInventory.json.refs.some((item: any) => item.platform === "linkedin" && item.accountRef === "company-page"));

  const archived = await requestJson(
    "DELETE",
    `/api/v1/companies/api_company_state/automations/${automation.id}`,
    undefined,
    { "if-match": "1" }
  );
  assert.equal(archived.status, 200, archived.raw);
  assert.equal(archived.json.automation.status, "archived");
  const scheduleAfterArchive = await requestJson(
    "GET",
    `/api/v1/companies/api_company_state/automations/${automation.id}/schedule`
  );
  assert.equal(scheduleAfterArchive.status, 200, scheduleAfterArchive.raw);
  assert.equal(scheduleAfterArchive.json.schedule.enabled, false);
  assert.equal(scheduleAfterArchive.json.schedule.status, "paused");
  assert.ok(scheduleAfterArchive.json.schedule.pausedAt);
});

function setActor(actorId: string): void {
  process.env.AUTOMATION_OS_OWNER_USER_ID = actorId;
}

function seedMembership(companyId: string, userId: string, role: "owner" | "admin" | "operator" | "viewer"): void {
  const timestamp = new Date().toISOString();
  execSql(`
    INSERT OR IGNORE INTO users (
      id, auth_provider, auth_subject, email, display_name, kind, status, created_at, updated_at
    ) VALUES (
      ${sqlValue(userId)}, 'test', ${sqlValue(userId)}, NULL, ${sqlValue(userId)}, 'human', 'active', ${sqlValue(timestamp)}, ${sqlValue(timestamp)}
    );
    INSERT OR IGNORE INTO companies (id, slug, name, status, created_at, updated_at)
    VALUES (${sqlValue(companyId)}, ${sqlValue(companyId)}, ${sqlValue(companyId)}, 'active', ${sqlValue(timestamp)}, ${sqlValue(timestamp)});
    INSERT OR IGNORE INTO company_memberships (id, company_id, user_id, role, status, created_at, updated_at)
    VALUES (
      ${sqlValue(`membership_${companyId}_${userId}`)}, ${sqlValue(companyId)}, ${sqlValue(userId)}, ${sqlValue(role)},
      'active', ${sqlValue(timestamp)}, ${sqlValue(timestamp)}
    );
  `);
}

function automationBody(name: string) {
  return {
    automation_type: "scheduled",
    name,
    description: `${name} description`,
    goal: `${name} goal`,
    lane: "local",
    risk_level: "high",
    approval_policy: "required_before_external_action",
    worker_command_kind: "safe_local_demo",
    create_approval: true,
    builder_spec: { source: "api-test" }
  };
}

async function createV1(companyId: string, name: string, idempotencyKey: string): Promise<any> {
  const response = await requestJson(
    "POST",
    `/api/v1/companies/${encodeURIComponent(companyId)}/automations`,
    automationBody(name),
    { "idempotency-key": idempotencyKey }
  );
  assert.equal(response.status, 201, response.raw);
  return response.json.automation;
}

function countRows(table: string, predicate: string): number {
  return Number(querySql<{ count: number }>(`SELECT count(*) AS count FROM ${table} WHERE ${predicate}`)[0].count);
}

async function requestJson(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<{ status: number; raw: string; json: any }> {
  const response = await request(method, path, body, extraHeaders);
  return { status: response.status, raw: response.body, json: JSON.parse(response.body) };
}

function request(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const req = Readable.from(payload ? [Buffer.from(payload, "utf8")] : []) as NodeJS.ReadableStream & {
      method?: string;
      url?: string;
      headers?: Record<string, string>;
    };
    req.method = method;
    req.url = path;
    req.headers = {
      ...(payload ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } : {}),
      ...extraHeaders
    };
    const chunks: Buffer[] = [];
    const headers = new Map<string, unknown>();
    const res = {
      statusCode: 200,
      setHeader(name: string, value: unknown) { headers.set(name.toLowerCase(), value); return this; },
      getHeader(name: string) { return headers.get(name.toLowerCase()); },
      removeHeader(name: string) { headers.delete(name.toLowerCase()); },
      end(chunk?: string | Buffer) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        resolve({ status: this.statusCode, body: Buffer.concat(chunks).toString("utf8") });
        return this;
      }
    };
    (app as unknown as { handle(req: unknown, res: unknown, next: (error?: unknown) => void): void }).handle(req, res, reject);
  });
}

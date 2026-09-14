import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-registered-catalog-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");
process.env.NODE_TEST_CONTEXT = "1";
process.env.AUTOMATION_OS_OWNER_USER_ID = "catalog_owner";

const db = await import("../db/client.js");
const catalog = await import("../automations/registeredCatalog.js");

db.initDb();

test("catalog decomposes all six Codex App automations and Identity is candidate-scoped", () => {
  assert.equal(catalog.listRegisteredAutomationCatalog().length, 6);
  const identity = catalog.getRegisteredAutomationCatalogEntry("automation-3");
  assert.ok(identity);
  assert.deepEqual(identity.stages.map((stage) => stage.id), [
    "source_snapshot",
    "candidate_supply",
    "identity_admission",
    "browser_admission",
    "candidate_submit",
    "submit_readback",
    "ledger_sync",
    "cleanup"
  ]);
  assert.equal(identity.execution.externalActionDefault, false);
  assert.equal(identity.providerPolicy.codexIsNotAuthority, true);
  assert.ok(identity.stages.find((stage) => stage.id === "candidate_submit")?.requiredProof.includes("one_candidate_idempotency"));
  const identityAdoption = catalog.buildRegisteredAutomationAdoptionSpec(identity);
  assert.equal(identityAdoption.source, "automation_os_portable_workflow");
  assert.equal(identityAdoption.sourceReadback.appRegistration, "aos_catalog_readback");
  assert.equal(identityAdoption.portableDispatch?.queue, "aos_portable_workflow_run_queue");
  assert.equal(identityAdoption.portableDispatch?.codex_is_not_authority, true);
  assert.equal(identityAdoption.workflowAdapter?.schema, "aos.workflow_adapter_registry.v1");
  const nisenprints = catalog.getRegisteredAutomationCatalogEntry("nisenprints-daily-product-canva-printify-etsy-pinterest");
  assert.deepEqual(nisenprints && catalog.buildRegisteredAutomationAdoptionSpec(nisenprints).workflowAdapter?.provider_adapters
    .filter((adapter) => ["canva", "printify", "etsy", "pinterest"].includes(adapter.id))
    .map((adapter) => adapter.id), ["canva", "printify", "etsy", "pinterest"]);
});

test("every registered external Web workflow is bound to the canonical AOS Chrome Companion", () => {
  const browserEntries = catalog.listRegisteredAutomationCatalog().filter((entry) => entry.browserSurface === "aos_chrome_companion_profile_instance");
  assert.equal(browserEntries.length, 3);
  assert.ok(browserEntries.every((entry) => entry.browserSurface === "aos_chrome_companion_profile_instance"));
  assert.ok(browserEntries.every((entry) => entry.execution.defaultMode === "preflight_no_effect"));
  assert.ok(browserEntries.every((entry) => entry.execution.externalActionDefault === false));
  assert.ok(browserEntries.every((entry) => catalog.buildRegisteredAutomationAdoptionSpec(entry).workflowAdapter?.browser_surface === "aos_chrome_companion_profile_instance"));
});

test("catalog local entries expose a bound Mac-worker adapter and keep capability gaps explicit", () => {
  const nonPortable = catalog.listRegisteredAutomationCatalog().filter((entry) => entry.browserSurface === "none");
  assert.deepEqual(nonPortable.map((entry) => entry.sourceAutomationId), ["automation", "daily-backup-safety-check", "obsidian"]);
  for (const entry of nonPortable) {
    const adoption = catalog.buildRegisteredAutomationAdoptionSpec(entry);
    assert.equal(adoption.workflowAdapter?.workflow_id, entry.canonicalWorkflowId);
    assert.equal(adoption.workflowAdapter?.browser_surface, "none");
    assert.equal(adoption.portableDispatch?.operation_surface, "mac_local_worker");
    assert.equal(adoption.portableDispatch?.browser_surface, "none");
    assert.equal(entry.execution.adapterStatus === "runner_pending" || entry.execution.adapterStatus === "mac_worker_read_only_ready", true);
  }
});

test("registered catalog adoption is company-scoped, schedule-backed, active, and idempotent", () => {
  const now = db.nowIso();
  db.upsert("users", { id: "catalog_owner", auth_provider: "test", auth_subject: "catalog_owner", email: null, display_name: "Catalog owner", kind: "human", status: "active", created_at: now, updated_at: now });
  db.upsert("companies", { id: "company_a", slug: "company-a", name: "Company A", status: "active", created_at: now, updated_at: now });
  db.upsert("company_memberships", { id: "catalog_membership", company_id: "company_a", user_id: "catalog_owner", role: "owner", status: "active", created_at: now, updated_at: now });

  const first = catalog.adoptRegisteredAutomationCatalog({ companyId: "company_a", actorUserId: "catalog_owner" });
  assert.equal(first.adopted.length, 6);
  assert.ok(first.adopted.every((item) => item.automation.companyId === "company_a"));
  assert.ok(first.adopted.every((item) => item.automation.status === "active"));
  assert.ok(first.adopted.every((item) => item.schedule.enabled === true));
  assert.ok(first.adopted.every((item) => item.adoption.externalActionAllowed === false));
  assert.equal(first.adopted.find((item) => item.sourceAutomationId === "automation-3")?.schedule.expression, "07:30");
  assert.equal(first.adopted.find((item) => item.sourceAutomationId === "obsidian")?.schedule.kind, "weekly");

  const second = catalog.adoptRegisteredAutomationCatalog({ companyId: "company_a", actorUserId: "catalog_owner" });
  assert.deepEqual(second.adopted.map((item) => item.automation.id).sort(), first.adopted.map((item) => item.automation.id).sort());
  assert.equal(db.querySql("SELECT id FROM mvp_automations WHERE company_id='company_a'").length, 6);
  assert.equal(db.querySql("SELECT id FROM mvp_automation_schedules WHERE company_id='company_a'").length, 6);
  assert.equal(db.querySql("SELECT id FROM mvp_automations WHERE company_id='company_b'").length, 0);
});

test("async registered catalog adoption keeps the same company-scoped records", async () => {
  const result = await catalog.adoptRegisteredAutomationCatalogAsync({ companyId: "company_a", actorUserId: "catalog_owner", enableSchedules: true });
  assert.equal(result.adopted.length, 6);
  assert.ok(result.adopted.every((item) => item.automation.companyId === "company_a"));
  assert.ok(result.adopted.every((item) => item.schedule.status === "active"));
  assert.equal(result.adopted.find((item) => item.sourceAutomationId === "daily-backup-safety-check")?.adoption.unattendedEffectPolicy, "user_authorized_fixed_local_target.v1");
  assert.equal(result.adopted.find((item) => item.sourceAutomationId === "obsidian")?.adoption.unattendedEffectPolicy, "user_authorized_fixed_local_target.v1");
  assert.equal(db.querySql("SELECT id FROM mvp_automations WHERE company_id='company_a'").length, 6);
  assert.equal(db.querySql("SELECT id FROM mvp_automation_schedules WHERE company_id='company_a'").length, 6);
});

test("adoption upgrades a legacy registered slot in place without changing its schedule", async () => {
  const now = db.nowIso();
  db.upsert("companies", { id: "company_legacy", slug: "company-legacy", name: "Company Legacy", status: "active", created_at: now, updated_at: now });
  db.upsert("company_memberships", { id: "catalog_legacy_membership", company_id: "company_legacy", user_id: "catalog_owner", role: "owner", status: "active", created_at: now, updated_at: now });
  const sourceId = "automation";
  const automationId = catalog.deterministicCompanyAutomationId("company_legacy", sourceId);
  db.upsert("mvp_automations", {
    id: automationId,
    company_id: "company_legacy",
    project_id: "company_legacy",
    automation_type: "registered_workflow",
    name: "Legacy email workflow",
    description: "legacy",
    goal: "legacy",
    lane: "local",
    risk_level: "medium",
    approval_policy: "required_before_external_action",
    worker_command_kind: "email_review_registered",
    create_approval: 0,
    schedule: "daily",
    cadence: "daily",
    builder_spec_json: JSON.stringify({ schema: "legacy.registered_workflow.v0", sourceAutomationId: sourceId }),
    status: "active",
    archived_at: null,
    revision: 1,
    current_version_id: "legacy_version",
    created_at: now,
    updated_at: now
  });
  db.upsert("mvp_automation_schedules", {
    id: "legacy_schedule",
    company_id: "company_legacy",
    project_id: "company_legacy",
    automation_id: automationId,
    automation_version_id: null,
    kind: "daily",
    expression: "06:15",
    timezone: "Asia/Tokyo",
    enabled: 1,
    status: "active",
    revision: 4,
    next_run_at: null,
    last_run_at: null,
    catch_up_policy: "skip",
    paused_at: null,
    created_at: now,
    updated_at: now
  });
  const migrated = catalog.adoptRegisteredAutomationCatalog({ companyId: "company_legacy", actorUserId: "catalog_owner", sourceAutomationIds: [sourceId], enableSchedules: true });
  assert.equal(migrated.adopted[0].automation.builderSpec.schema, "aos.registered_automation_adoption.v1");
  assert.equal(migrated.adopted[0].schedule.id, "legacy_schedule");
  assert.equal(migrated.adopted[0].schedule.expression, "06:15");
  assert.equal(migrated.adopted[0].schedule.revision, 4);
});

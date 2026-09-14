import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-api-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");
// Readback can repair the backend mirror: keep that write inside this fixture.
process.env.AOS_WEB_OPERATION_BACKEND_CONFIG = join(tempRoot, "web-operation-backend.json");
const chromeReadbackPath = join(tempRoot, "chrome-plugin-readback.json");
process.env.AOS_CHROME_PLUGIN_READBACK_PATH = chromeReadbackPath;
const bridgeServer = createServer((req, res) => {
  if (req.url !== "/health") {
    res.statusCode = 404;
    res.end();
    return;
  }
  try {
    const browserReadback = JSON.parse(readFileSync(chromeReadbackPath, "utf8"));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      bridge_instance_id: browserReadback.bridge_instance_id,
      url: browserReadback.bridge_url,
      browser_readback: browserReadback,
    }));
  } catch {
    res.statusCode = 503;
    res.end(JSON.stringify({ exact_blocker: "test_bridge_readback_unavailable" }));
  }
});
bridgeServer.listen(0, "127.0.0.1");
await once(bridgeServer, "listening");
const bridgeAddress = bridgeServer.address();
if (!bridgeAddress || typeof bridgeAddress === "string") throw new Error("test_bridge_address_unavailable");
const testBridgeUrl = `http://127.0.0.1:${bridgeAddress.port}`;
writeFileSync(process.env.AOS_CHROME_PLUGIN_READBACK_PATH, JSON.stringify({
  schema: "aos.chrome_plugin_bridge_readback.v2",
  status: "ready",
  bridge_instance_id: "api-test-bridge",
  bridge_owner: { schema: "aos.chrome_plugin_bridge_owner.v1", owner_id: "api-test-owner", pid: 1234, bridge_instance_id: "api-test-bridge", session_id: "api-session", thread_id: "api-thread", turn_id: "api-turn", status: "foreground_ready", foreground_executor_ready: true, updated_at: new Date().toISOString() },
  bridge_url: testBridgeUrl,
  browser_execution_disabled: false,
  browser: { id: "api-test-browser", type: "extension", metadata: { profileOrdering: "2" } },
  operation_ready: true,
  operation_status: "ready",
  operation_exact_blocker: null,
  selected_tab: { id: "api-selected-tab", url: "https://example.test/" },
  visibility: { capability_id: "visibility", advertised: true, state: true },
  last_seen_at: new Date().toISOString()
}), { mode: 0o600 });
chmodSync(process.env.AOS_CHROME_PLUGIN_READBACK_PATH, 0o600);
process.env.NODE_TEST_CONTEXT = "1";
process.env.AUTOMATION_OS_OWNER_USER_ID = "api_bootstrap_owner";

const { app } = await import("../index.js");
const { execSql, initDb, querySql, sqlValue } = await import("../db/client.js");

initDb();

test.after(async () => {
  if (bridgeServer.listening) await new Promise<void>((resolve) => bridgeServer.close(() => resolve()));
});

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

test("company approval readback supports exact bounded filters and rejects ambiguous query values", async () => {
  seedMembership("api_approval_query", "api_approval_query_owner", "owner");
  seedMembership("api_approval_query_other", "api_approval_query_other_owner", "owner");
  seedCompanyApproval("api_approval_query", "approval_query_target", "run_query_target", "pending", "2029-01-01T00:00:00.000Z");
  seedCompanyApproval("api_approval_query", "approval_query_other", "run_query_other", "approved", "2030-01-01T00:00:00.000Z");
  seedCompanyApproval("api_approval_query_other", "approval_query_foreign", "run_query_target", "pending");
  setActor("api_approval_query_owner");

  const filtered = await requestJson(
    "GET",
    "/api/v1/companies/api_approval_query/approvals?run_id=run_query_target&status=pending&action_kind=business_execute&limit=1"
  );
  assert.equal(filtered.status, 200, filtered.raw);
  assert.deepEqual(filtered.json.approvals.map((approval: any) => approval.id), ["approval_query_target"]);
  assert.equal(filtered.json.count, 1);
  assert.deepEqual(filtered.json.query, {
    limit: 1,
    run_id: "run_query_target",
    status: "pending",
    action_kind: "business_execute"
  });
  assert.doesNotMatch(filtered.raw, /approval_query_foreign/);

  const capped = await requestJson("GET", "/api/v1/companies/api_approval_query/approvals?limit=999");
  assert.equal(capped.status, 200, capped.raw);
  assert.equal(capped.json.query.limit, 500);

  const arrayValue = await requestJson("GET", "/api/v1/companies/api_approval_query/approvals?run_id=run_query_target&run_id=run_query_other");
  assert.equal(arrayValue.status, 400, arrayValue.raw);
  assert.equal(arrayValue.json.exactBlocker, "approval_query_scalar_required");
  const invalidStatus = await requestJson("GET", "/api/v1/companies/api_approval_query/approvals?status=done");
  assert.equal(invalidStatus.status, 400, invalidStatus.raw);
  assert.equal(invalidStatus.json.exactBlocker, "approval_status_invalid");
  const invalidLimit = await requestJson("GET", "/api/v1/companies/api_approval_query/approvals?limit=not-a-number");
  assert.equal(invalidLimit.status, 400, invalidLimit.raw);
  assert.equal(invalidLimit.json.exactBlocker, "approval_limit_invalid");

  setActor("api_approval_query_other_owner");
  const foreign = await requestJson("GET", "/api/v1/companies/api_approval_query/approvals?run_id=run_query_target");
  assert.equal(foreign.status, 404, foreign.raw);
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
  assert.equal(item.schedule, "09:00");
  assert.equal(item.cadence, "daily");
  assert.equal(item.schedule_status, "active");
  assert.equal(item.schedule_enabled, true);
  assert.equal(item.status, "active");
  assert.equal(item.revision, 2);
  assert.equal(item.schedule_timezone, "Asia/Tokyo");
  assert.equal(item.pinned_schedule_version_id, schedule.json.schedule.automationVersionId);
  assert.ok(Number.isFinite(Date.parse(item.next_run_at)), listed.raw);
});

test("automation readback separates verified company Gmail connection from explicit execution target", async () => {
  seedMembership("api_gmail_execution_target", "api_gmail_execution_owner", "owner");
  setActor("api_gmail_execution_owner");
  const connection = await requestJson(
    "PUT",
    "/api/v1/companies/api_gmail_execution_target/connection-account-refs/gmail/company-account",
    { status: "verified", scopes: ["read"], oauth_state: "connected", verification_status: "verified", last_verified_at: "2026-07-15T00:00:00.000Z" }
  );
  assert.equal(connection.status, 200, connection.raw);
  const gmailRefId = connection.json.connection.id;
  const unbound = await requestJson(
    "POST",
    "/api/v1/companies/api_gmail_execution_target/automations",
    { ...automationBody("Gmail unbound"), builder_spec: { canonicalWorkflowId: "email-review-reply" } },
    { "idempotency-key": "api-gmail-unbound" }
  );
  assert.equal(unbound.status, 201, unbound.raw);
  assert.equal(unbound.json.automation.execution_target.state, "unbound");
  assert.equal(unbound.json.automation.execution_target.connection_evidence, "verified");
  assert.equal(unbound.json.automation.execution_target.exact_blocker, "execution_target_unbound");
  assert.equal(unbound.json.automation.external_action_allowed, false);

  const bound = await requestJson(
    "POST",
    "/api/v1/companies/api_gmail_execution_target/automations",
    { ...automationBody("Gmail bound"), builder_spec: { canonicalWorkflowId: "email-review-reply", execution_target: { connection_ref_id: gmailRefId } } },
    { "idempotency-key": "api-gmail-bound" }
  );
  assert.equal(bound.status, 201, bound.raw);
  assert.equal(bound.json.automation.execution_target.state, "bound");
  assert.equal(bound.json.automation.execution_target.connection_ref_id, gmailRefId);
  assert.equal(bound.json.automation.execution_target.account_ref, "company-account");

  const listed = await requestJson("GET", "/api/v1/companies/api_gmail_execution_target/automations");
  assert.equal(listed.status, 200, listed.raw);
  const listedBound = listed.json.automations.find((item: any) => item.id === bound.json.automation.id);
  assert.equal(listedBound.execution_target.state, "bound");
  const listedUnbound = listed.json.automations.find((item: any) => item.id === unbound.json.automation.id);
  assert.equal(listedUnbound.execution_target.state, "unbound");

  const mvpListed = await requestJson("GET", "/api/mvp/automations?project_id=api_gmail_execution_target");
  assert.equal(mvpListed.status, 200, mvpListed.raw);
  const mvpBound = mvpListed.json.automations.find((item: any) => item.id === bound.json.automation.id);
  assert.equal(mvpBound.execution_target.state, "bound");
  assert.equal(mvpBound.execution_target.connection_ref_id, gmailRefId);

  const detail = await requestJson("GET", `/api/v1/companies/api_gmail_execution_target/automations/${bound.json.automation.id}`);
  assert.equal(detail.status, 200, detail.raw);
  assert.equal(detail.json.automation.execution_target.state, "bound");
  assert.equal(detail.json.company_scope.company_id, "api_gmail_execution_target");
});

test("AOS control-plane readiness is a company-scoped no-effect bridge contract", async () => {
  seedMembership("api_control_plane_readiness", "api_control_plane_owner", "owner");
  seedMembership("api_control_plane_viewer", "api_control_plane_viewer", "viewer");
  seedMembership("api_control_plane_unaffiliated", "api_control_plane_unaffiliated", "owner");
  setActor("api_control_plane_owner");
  const beforeJobs = countRows("durable_jobs", "1=1");
  const beforeRuns = countRows("runs", "1=1");

  const response = await requestJson(
    "GET",
    "/api/v1/companies/api_control_plane_readiness/control-plane/readiness"
  );
  assert.equal(response.status, 200, response.raw);
  assert.equal(response.json.schema, "aos.control_plane_readiness.v1");
  assert.equal(response.json.status, "ready_for_no_effect_trigger");
  assert.equal(response.json.readiness_basis, "runtime_control_plane_handler_presence");
  assert.equal(response.json.exact_blocker, null);
  assert.deepEqual(response.json.company_scope, {
    enforced: true,
    company_id: "api_control_plane_readiness"
  });
  assert.deepEqual(response.json.authority, {
    provider: "aos.control_plane",
    contract: "aos.execution_provider.v1",
    owner: "automation_os_control_plane",
    source_of_truth: "aos_scheduler_durable_queue",
    worker_boundary: "mac_worker_chrome_plugin_profile2",
    browser_surface: "signed_chrome_extension_profile2",
    fallback_policy: "no_implicit_fallback"
  });
  assert.equal(response.json.routes.manual_trigger.available, true);
  assert.equal(response.json.routes.manual_trigger.execution_mode, "preflight_no_effect");
  assert.equal(response.json.routes.manual_trigger.idempotency_key_required, true);
  assert.equal(response.json.routes.manual_trigger.external_action_allowed, false);
  assert.equal(response.json.routes.scheduler_run_once.server_owned, true);
  assert.equal(response.json.routes.scheduler_run_once.scheduler_owner, "server");
  assert.equal(response.json.routes.scheduler_run_once.execution_mode, "durable_queue_materialization");
  assert.equal(response.json.queue.durable, true);
  assert.equal(response.json.queue.business_completion, false);
  assert.equal(response.json.client_boundary.client_neutral, true);
  assert.equal(response.json.client_boundary.codex_app_role, "thin_trigger_only");
  assert.equal(response.json.client_boundary.alternate_llm_role, "thin_trigger_only");
  assert.equal(response.json.production_guard.token_value_exposed, false);
  assert.equal(response.json.external_action_executed, false);
  assert.equal(response.json.secrets_read, false);
  assert.equal(response.json.company_binding_readiness.schema, "company_binding_readiness.v1");
  assert.equal(response.json.company_binding_readiness.production_ready, false);
  assert.equal(response.json.company_binding_readiness.canonical_company_id, null);
  assert.equal(response.json.company_binding_readiness.external_action_executed, false);
  assert.equal(response.json.company_binding_readiness.graph_receipt.replay_allowed, false);
  assert.equal(response.json.company_binding_reconciliation.schema, "company_binding_reconciliation.v1");
  assert.equal(response.json.company_binding_reconciliation.canonical_company_id, null);
  assert.equal(response.json.company_binding_reconciliation.selection.selected, false);
  assert.equal(response.json.company_binding_reconciliation.external_action_executed, false);
  assert.equal(response.json.canonical_company_consultation.schema, "canonical_company_consultation.v1");
  assert.equal(response.json.canonical_company_consultation.selection_state, "unresolved");
  assert.equal(response.json.canonical_company_consultation.canonical_company_id, null);
  assert.equal(response.json.canonical_company_consultation.owner_decision.required, true);
  assert.equal(response.json.canonical_company_consultation.owner_decision.recommended_candidate_company_id, null);
  assert.equal(response.json.canonical_company_consultation.external_action_executed, false);
  const reconciliation = await requestJson(
    "GET",
    "/api/v1/companies/api_control_plane_readiness/control-plane/reconciliation"
  );
  assert.equal(reconciliation.status, 200, reconciliation.raw);
  assert.equal(reconciliation.json.schema, "company_binding_reconciliation.v1");
  assert.equal(reconciliation.json.canonical_company_id, null);
  assert.equal(reconciliation.json.mutation.schedules_materialized, false);
  const consultation = await requestJson(
    "GET",
    "/api/v1/companies/api_control_plane_readiness/control-plane/consultation"
  );
  assert.equal(consultation.status, 200, consultation.raw);
  assert.equal(consultation.json.schema, "canonical_company_consultation.v1");
  assert.equal(consultation.json.selection_state, "unresolved");
  assert.equal(consultation.json.exact_blocker, "canonical_company_unresolved");
  assert.equal(consultation.json.downstream.provider_receipt.status, "not_attempted");
  assert.equal(consultation.json.downstream.source_sync.status, "not_attempted");
  assert.equal(consultation.json.downstream.reconciliation.status, "not_attempted");
  assert.equal(consultation.json.downstream.cleanup.status, "not_attempted");
  assert.equal(consultation.headers["cache-control"], "no-store");
  assert.doesNotMatch(consultation.raw, /AUTOMATION_OS_(?:READ|WRITE)_TOKEN|Bearer\s+|secret_value|password|sentinel-read-token|sentinel-write-token/iu);
  assert.doesNotMatch(response.raw, /AUTOMATION_OS_(?:READ|WRITE)_TOKEN|Bearer\s+|secret_value|password|sentinel-read-token|sentinel-write-token/iu);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.doesNotMatch(JSON.stringify(response.headers), /sentinel-read-token|sentinel-write-token/iu);
  assert.equal(countRows("durable_jobs", "1=1"), beforeJobs);
  assert.equal(countRows("runs", "1=1"), beforeRuns);

  setActor("api_owner_a");
  const forbidden = await requestJson(
    "GET",
    "/api/v1/companies/api_control_plane_readiness/control-plane/readiness"
  );
  assert.equal(forbidden.status, 404, forbidden.raw);
  assert.equal(forbidden.json.error, "company_scope_forbidden");

  setActor("api_control_plane_viewer");
  const disallowedRole = await requestJson(
    "GET",
    "/api/v1/companies/api_control_plane_viewer/control-plane/readiness"
  );
  assert.equal(disallowedRole.status, 404, disallowedRole.raw);
  assert.equal(disallowedRole.json.error, "company_scope_forbidden");

  setActor("api_control_plane_unaffiliated");
  const unaffiliated = await requestJson(
    "GET",
    "/api/v1/companies/api_control_plane_readiness/control-plane/readiness"
  );
  assert.equal(unaffiliated.status, 404, unaffiliated.raw);
  assert.equal(unaffiliated.json.error, "company_scope_forbidden");

  const previousRequireApi = process.env.AUTOMATION_OS_REQUIRE_API_TOKEN;
  const previousReadToken = process.env.AUTOMATION_OS_READ_TOKEN;
  const previousWriteToken = process.env.AUTOMATION_OS_WRITE_TOKEN;
  process.env.AUTOMATION_OS_REQUIRE_API_TOKEN = "1";
  process.env.AUTOMATION_OS_READ_TOKEN = "sentinel-read-token";
  process.env.AUTOMATION_OS_WRITE_TOKEN = "sentinel-write-token";
  try {
    const missingToken = await requestJson(
      "GET",
      "/api/v1/companies/api_control_plane_readiness/control-plane/readiness"
    );
    assert.equal(missingToken.status, 401, missingToken.raw);
    assert.equal(missingToken.json.exactBlocker, "production_token_required");
    assert.doesNotMatch(missingToken.raw, /sentinel-read-token|sentinel-write-token/iu);

    const invalidToken = await requestJson(
      "GET",
      "/api/v1/companies/api_control_plane_readiness/control-plane/readiness",
      undefined,
      { "x-automation-os-token": "wrong-sentinel-token" }
    );
    assert.equal(invalidToken.status, 401, invalidToken.raw);
    assert.equal(invalidToken.json.exactBlocker, "production_token_required");

    setActor("api_control_plane_owner");
    const tokenAllowed = await requestJson(
      "GET",
      "/api/v1/companies/api_control_plane_readiness/control-plane/readiness",
      undefined,
      { "x-automation-os-token": "sentinel-read-token" }
    );
    assert.equal(tokenAllowed.status, 200, tokenAllowed.raw);
    assert.doesNotMatch(tokenAllowed.raw, /sentinel-read-token|sentinel-write-token/iu);
    assert.doesNotMatch(JSON.stringify(tokenAllowed.headers), /sentinel-read-token|sentinel-write-token/iu);
  } finally {
    if (previousRequireApi === undefined) delete process.env.AUTOMATION_OS_REQUIRE_API_TOKEN;
    else process.env.AUTOMATION_OS_REQUIRE_API_TOKEN = previousRequireApi;
    if (previousReadToken === undefined) delete process.env.AUTOMATION_OS_READ_TOKEN;
    else process.env.AUTOMATION_OS_READ_TOKEN = previousReadToken;
    if (previousWriteToken === undefined) delete process.env.AUTOMATION_OS_WRITE_TOKEN;
    else process.env.AUTOMATION_OS_WRITE_TOKEN = previousWriteToken;
  }
});

test("trusted admin ingress admits read-only company readbacks without widening write access", async () => {
  seedMembership("api_private_ingress_company", "api_private_ingress_owner", "owner");
  setActor("api_private_ingress_owner");
  const previousRequireApi = process.env.AUTOMATION_OS_REQUIRE_API_TOKEN;
  const previousPrivateIngress = process.env.AUTOMATION_OS_PRIVATE_INGRESS_SECRET;
  process.env.AUTOMATION_OS_REQUIRE_API_TOKEN = "1";
  process.env.AUTOMATION_OS_PRIVATE_INGRESS_SECRET = "private-ingress-test-secret-012345678901234567890123";
  try {
    const readback = await requestJson(
      "GET",
      "/api/v1/companies/api_private_ingress_company/control-plane/readiness",
      undefined,
      { "x-automation-os-private-ingress": process.env.AUTOMATION_OS_PRIVATE_INGRESS_SECRET }
    );
    assert.equal(readback.status, 200, readback.raw);
    assert.equal(readback.json.external_action_executed, false);
    assert.doesNotMatch(readback.raw, /private-ingress-test-secret/iu);

    const write = await requestJson(
      "POST",
      "/api/runs/start",
      { company_id: "api_private_ingress_company", command: "must remain token-gated" },
      { "x-automation-os-private-ingress": process.env.AUTOMATION_OS_PRIVATE_INGRESS_SECRET }
    );
    assert.equal(write.status, 401, write.raw);
    assert.equal(write.json.exactBlocker, "production_token_required");
  } finally {
    if (previousRequireApi === undefined) delete process.env.AUTOMATION_OS_REQUIRE_API_TOKEN;
    else process.env.AUTOMATION_OS_REQUIRE_API_TOKEN = previousRequireApi;
    if (previousPrivateIngress === undefined) delete process.env.AUTOMATION_OS_PRIVATE_INGRESS_SECRET;
    else process.env.AUTOMATION_OS_PRIVATE_INGRESS_SECRET = previousPrivateIngress;
  }
});

test("operator capability separates read-only and write tokens without returning token values", async () => {
  const previousRequireApi = process.env.AUTOMATION_OS_REQUIRE_API_TOKEN;
  const previousReadToken = process.env.AUTOMATION_OS_READ_TOKEN;
  const previousWriteToken = process.env.AUTOMATION_OS_WRITE_TOKEN;
  process.env.AUTOMATION_OS_REQUIRE_API_TOKEN = "1";
  process.env.AUTOMATION_OS_READ_TOKEN = "capability-read-sentinel";
  process.env.AUTOMATION_OS_WRITE_TOKEN = "capability-write-sentinel";
  try {
    const missing = await requestJson("GET", "/api/auth/capability");
    assert.equal(missing.status, 401, missing.raw);
    assert.equal(missing.json.exactBlocker, "production_token_required");

    const read = await requestJson("GET", "/api/auth/capability", undefined, { "x-automation-os-token": "capability-read-sentinel" });
    assert.equal(read.status, 200, read.raw);
    assert.equal(read.json.scope, "read");
    assert.equal(read.json.read_only, true);
    assert.doesNotMatch(read.raw, /capability-read-sentinel|capability-write-sentinel/iu);

    const write = await requestJson("GET", "/api/auth/capability", undefined, { "x-automation-os-token": "capability-write-sentinel" });
    assert.equal(write.status, 200, write.raw);
    assert.equal(write.json.scope, "write");
    assert.equal(write.json.read_only, false);
    assert.doesNotMatch(write.raw, /capability-read-sentinel|capability-write-sentinel/iu);
  } finally {
    if (previousRequireApi === undefined) delete process.env.AUTOMATION_OS_REQUIRE_API_TOKEN;
    else process.env.AUTOMATION_OS_REQUIRE_API_TOKEN = previousRequireApi;
    if (previousReadToken === undefined) delete process.env.AUTOMATION_OS_READ_TOKEN;
    else process.env.AUTOMATION_OS_READ_TOKEN = previousReadToken;
    if (previousWriteToken === undefined) delete process.env.AUTOMATION_OS_WRITE_TOKEN;
    else process.env.AUTOMATION_OS_WRITE_TOKEN = previousWriteToken;
  }
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
  assert.equal(readback.json.automations[0].exact_blocker, "registered_automation_effect_stage_not_admitted");
  assert.equal(readback.json.automations[0].resume_condition, "読み取り専用の確認要求は受付可能です。業務実行は未許可です。");
  assert.equal(readback.json.automations[0].can_preflight, true);
  assert.equal(readback.json.automations[0].preflight_stage, "reference_readback");
  assert.equal(readback.json.automations[0].portable.read_only_preflight, true);
  assert.equal(readback.json.automations[0].manual_trigger.available, true);
  assert.equal(readback.json.automations[0].manual_trigger.execution_mode, "preflight_no_effect");
  assert.equal(readback.json.automations[0].manual_trigger.provider_neutral, true);
  assert.equal(readback.json.automations[0].manual_trigger.external_action_allowed, false);
  const previousZeabur = process.env.ZEABUR;
  const previousEnvironmentRole = process.env.AUTOMATION_OS_ENV_ROLE;
  try {
    // The hosted control plane must not inspect the Mac-only bridge path to
    // decide whether a safe read-only stage may be handed to the worker.
    process.env.ZEABUR = "1";
    process.env.AUTOMATION_OS_ENV_ROLE = "production";
    writeFileSync(process.env.AOS_CHROME_PLUGIN_READBACK_PATH!, "{}", { mode: 0o600 });
    const hostedReadback = await requestJson("GET", "/api/mvp/registered-automations?project_id=api_registered_company");
    assert.equal(hostedReadback.status, 200, hostedReadback.raw);
    assert.equal(hostedReadback.json.automations[0].can_preflight, true);
    assert.equal(hostedReadback.json.automations[0].preflight_stage, "reference_readback");
    assert.equal(hostedReadback.json.automations[0].preflight_exact_blocker, null);
    assert.equal(hostedReadback.json.automations[0].preflight_status, "readiness_pass");
  } finally {
    if (previousZeabur === undefined) delete process.env.ZEABUR;
    else process.env.ZEABUR = previousZeabur;
    if (previousEnvironmentRole === undefined) delete process.env.AUTOMATION_OS_ENV_ROLE;
    else process.env.AUTOMATION_OS_ENV_ROLE = previousEnvironmentRole;
  }
  for (const item of readback.json.automations) {
    if (item.latest_proof) assert.equal(item.latest_proof.same_run_receipt, false);
  }
  assert.equal(readback.json.automations[0].toml_ref, null);
  assert.doesNotMatch(readback.raw, /\/Users\//);
  const promptTransferLane = readback.json.automations.find((item: any) => item.id === "prompt-transfer-ukiyoe");
  assert.equal(promptTransferLane?.can_run, false);
  assert.equal(promptTransferLane?.can_preflight, true);
  assert.equal(promptTransferLane?.preflight_stage, "reference_readback");
  assert.equal(promptTransferLane?.preflight_exact_blocker, null);
  assert.equal(promptTransferLane?.portable?.read_only_preflight, true);
  for (const workflowId of ["sns-multi-poster-ukiyoe", "x-authenticated-browser-lane"]) {
    const lane = readback.json.automations.find((item: any) => item.id === workflowId);
    assert.equal(lane?.can_run, false);
    assert.equal(lane?.can_preflight, true);
    assert.equal(lane?.preflight_stage, "reference_readback");
    assert.equal(lane?.preflight_exact_blocker, null);
    assert.equal(lane?.portable?.read_only_preflight, true);
  }
  const dailyLane = readback.json.automations.find((item: any) => item.id === "daily-ai-research-publish-run")?.browser_use_lane;
  assert.equal(dailyLane?.profileRef, "scheduled/daily-ai");
  assert.equal(dailyLane?.reservedPort, 19882);
  assert.equal(dailyLane?.liveReadbackStatus, "not_claimed");
  assert.doesNotMatch(JSON.stringify(dailyLane), /profileDir|lockPath|browserUseCdpUrl|\/Users\//);

  writeFileSync(process.env.AOS_CHROME_PLUGIN_READBACK_PATH!, JSON.stringify({
    schema: "aos.chrome_plugin_bridge_readback.v2",
    status: "ready",
    bridge_instance_id: "api-test-bridge",
    bridge_owner: { schema: "aos.chrome_plugin_bridge_owner.v1", owner_id: "api-test-owner", pid: 1234, bridge_instance_id: "api-test-bridge", session_id: "api-session", thread_id: "api-thread", turn_id: "api-turn", status: "foreground_ready", foreground_executor_ready: true, updated_at: new Date().toISOString() },
    bridge_url: testBridgeUrl,
    browser_execution_disabled: false,
    browser: { id: "api-test-browser", type: "extension", metadata: { profileOrdering: "2" } },
    operation_ready: true,
    operation_status: "ready",
    operation_exact_blocker: null,
    selected_tab: { id: "api-selected-tab", url: "https://example.test/" },
    visibility: { capability_id: "visibility", advertised: true, state: true },
    last_seen_at: "2020-01-01T00:00:00.000Z"
  }), { mode: 0o600 });
  const staleRegistered = await requestJson("GET", "/api/mvp/registered-automations?project_id=api_registered_company");
  assert.equal(staleRegistered.status, 200, staleRegistered.raw);
  assert.equal(staleRegistered.json.automations[0].can_preflight, false);
  assert.equal(staleRegistered.json.automations[0].preflight_stage, null);
  assert.equal(staleRegistered.json.automations[0].preflight_exact_blocker, "chrome_extension_bridge_readback_stale");
  writeFileSync(process.env.AOS_CHROME_PLUGIN_READBACK_PATH!, JSON.stringify({
    schema: "aos.chrome_plugin_bridge_readback.v2",
    status: "ready",
    bridge_instance_id: "api-test-bridge",
    bridge_owner: { schema: "aos.chrome_plugin_bridge_owner.v1", owner_id: "api-test-owner", pid: 1234, bridge_instance_id: "api-test-bridge", session_id: "api-session", thread_id: "api-thread", turn_id: "api-turn", status: "foreground_ready", foreground_executor_ready: true, updated_at: new Date().toISOString() },
    bridge_url: testBridgeUrl,
    browser_execution_disabled: false,
    browser: { id: "api-test-browser", type: "extension", metadata: { profileOrdering: "2" } },
    operation_ready: true,
    operation_status: "ready",
    operation_exact_blocker: null,
    selected_tab: { id: "api-selected-tab", url: "https://example.test/" },
    visibility: { capability_id: "visibility", advertised: true, state: true },
    last_seen_at: new Date().toISOString()
  }), { mode: 0o600 });

  const run = await requestJson(
    "POST",
    `/api/mvp/registered-automations/${encodeURIComponent(readback.json.automations[0].id)}/run?project_id=api_registered_company`,
    {}
  );
  assert.equal(run.status, 200, run.raw);
  assert.equal(run.json.read_only, true);
  assert.equal(run.json.external_action_executed, false);
  assert.match(run.json.exact_blocker, /registered_automation_/);

  const registeredTrigger = await requestJson(
    "POST",
    "/api/v1/companies/api_registered_company/automations/daily-ai-research-publish-run/trigger",
    { execution_mode: "preflight_no_effect", provider_neutral: true, external_action_allowed: false },
    { "idempotency-key": "api-registered-workflow-trigger" }
  );
  assert.equal(registeredTrigger.status, 202, registeredTrigger.raw);
  assert.equal(registeredTrigger.json.schema, "aos.portable_workflow_trigger.v1");
  assert.equal(registeredTrigger.json.workflow_id, "daily-ai-research-publish-run");
  assert.equal(registeredTrigger.json.run.company_id, "api_registered_company");
  assert.equal(registeredTrigger.json.run.automation_id, "daily-ai-research-publish-run");
  assert.equal(registeredTrigger.json.run.automation_version_id, null);
  assert.equal(registeredTrigger.json.provider_neutral, true);
  assert.equal(registeredTrigger.json.external_action_executed, false);

  const portableKey = "api-portable-manual-dedup";
  const portable = await requestJson(
    "POST",
    "/api/portable-workflows/daily-ai-research-publish-run/run?project_id=api_registered_company",
    { project_id: "api_registered_company", idempotency_key: portableKey, read_only_stage: "reference_readback" },
    { "idempotency-key": portableKey }
  );
  assert.equal(portable.status, 202, portable.raw);
  assert.equal(portable.json.ok, true);
  assert.equal(portable.json.portable.app_dependency, false);
  assert.equal(portable.json.portable.source_trigger, "automation_os_ui");
  assert.equal(portable.json.portable.external_action_executed, false);
  assert.equal(portable.json.portable.execution_mode, "external");
  assert.equal(portable.json.workerProtocol, "local_worker_loop_required");
  // The automatic route uses Companion for normal/read-only browser work;
  // official Chrome Plugin remains available when explicitly selected.
  assert.equal(portable.json.portable.backend, "aos_chrome_companion");
  assert.equal(portable.json.portable.browser_surface, "aos_chrome_companion_profile_instance");

  const backendBeforeSwitch = await requestJson("GET", "/api/v1/settings/web-operation-backend");
  assert.equal(backendBeforeSwitch.status, 200, backendBeforeSwitch.raw);
  const playwrightSwitch = await requestJson(
    "PUT",
    "/api/v1/settings/web-operation-backend",
    { backend: "playwright", expected_revision: backendBeforeSwitch.json.setting.revision }
  );
  assert.equal(playwrightSwitch.status, 200, playwrightSwitch.raw);
  assert.equal(playwrightSwitch.json.setting.backend, "playwright");
  const playwrightRegistered = await requestJson("GET", "/api/mvp/registered-automations?project_id=api_registered_company");
  assert.equal(playwrightRegistered.status, 200, playwrightRegistered.raw);
  assert.equal(playwrightRegistered.json.automations[0].can_run, false);
  assert.equal(playwrightRegistered.json.automations[0].can_preflight, false);
  assert.equal(playwrightRegistered.json.automations[0].preflight_stage, null);
  assert.equal(playwrightRegistered.json.automations[0].preflight_exact_blocker, "portable_external_read_only_backend_not_implemented:playwright");
  assert.equal(playwrightRegistered.json.automations[0].portable.backend, "playwright");
  assert.equal(playwrightRegistered.json.automations[0].portable.browser_surface, "playwright");
  const chromeRestore = await requestJson(
    "PUT",
    "/api/v1/settings/web-operation-backend",
    { backend: "chrome_plugin", expected_revision: playwrightSwitch.json.setting.revision }
  );
  assert.equal(chromeRestore.status, 200, chromeRestore.raw);
  assert.equal(chromeRestore.json.setting.backend, "chrome_plugin");

  const browserUseSwitch = await requestJson(
    "PUT",
    "/api/v1/settings/web-operation-backend",
    { backend: "browser_use_cli", expected_revision: chromeRestore.json.setting.revision }
  );
  assert.equal(browserUseSwitch.status, 200, browserUseSwitch.raw);
  const browserUseRegistered = await requestJson("GET", "/api/mvp/registered-automations?project_id=api_registered_company");
  assert.equal(browserUseRegistered.status, 200, browserUseRegistered.raw);
  const browserUseSns = browserUseRegistered.json.automations.find((item: any) => item.id === "sns-multi-poster-ukiyoe");
  assert.equal(browserUseSns?.can_preflight, true);
  assert.equal(browserUseSns?.preflight_exact_blocker, null);
  const browserUseX = browserUseRegistered.json.automations.find((item: any) => item.id === "x-authenticated-browser-lane");
  assert.equal(browserUseX?.can_preflight, true);
  assert.equal(browserUseX?.preflight_exact_blocker, null);

  const concurrentBaseRevision = browserUseSwitch.json.setting.revision;
  const [concurrentChrome, concurrentPlaywright] = await Promise.all([
    requestJson(
      "PUT",
      "/api/v1/settings/web-operation-backend",
      { backend: "chrome_plugin", expected_revision: concurrentBaseRevision }
    ),
    requestJson(
      "PUT",
      "/api/v1/settings/web-operation-backend",
      { backend: "playwright", expected_revision: concurrentBaseRevision }
    ),
  ]);
  const concurrentResults = [concurrentChrome, concurrentPlaywright];
  assert.equal(concurrentResults.filter((result) => result.status === 200).length, 1);
  assert.equal(concurrentResults.filter((result) => result.status === 409).length, 1);
  const concurrentWinner = concurrentResults.find((result) => result.status === 200)!;
  const concurrentLoser = concurrentResults.find((result) => result.status === 409)!;
  assert.equal(concurrentWinner.json.setting.revision, concurrentBaseRevision + 1);
  assert.match(concurrentLoser.json.error, /^web_operation_backend_revision_conflict:/u);
  const browserUseRestore = await requestJson(
    "PUT",
    "/api/v1/settings/web-operation-backend",
    { backend: "chrome_plugin", expected_revision: concurrentWinner.json.setting.revision }
  );
  assert.equal(browserUseRestore.status, 200, browserUseRestore.raw);
  assert.equal(browserUseRestore.json.setting.backend, "chrome_plugin");

  const portableReplay = await requestJson(
    "POST",
    "/api/portable-workflows/daily-ai-research-publish-run/run?project_id=api_registered_company",
    { project_id: "api_registered_company", idempotency_key: portableKey, read_only_stage: "reference_readback" },
    { "idempotency-key": portableKey }
  );
  assert.equal(portableReplay.status, 202, portableReplay.raw);
  assert.equal(portableReplay.json.replayed, true);
  assert.equal(portableReplay.json.runId, portable.json.runId);

  setActor("api_registered_other_owner");
  const forbidden = await requestJson("GET", "/api/mvp/registered-automations?project_id=api_registered_company");
  assert.equal(forbidden.status, 403, forbidden.raw);
});

test("legacy registered automation run queues one read-only run for a saved local mvp automation", async () => {
  const companyId = "api_registered_local_company";
  seedMembership(companyId, "api_registered_local_owner", "owner");
  setActor("api_registered_local_owner");

  const adopted = await requestJson(
    "POST",
    `/api/v1/companies/${companyId}/registered-automations/adopt`,
    { source_automation_ids: ["daily-backup-safety-check"], enable_schedules: false },
    { "idempotency-key": "api-registered-local-adopt" }
  );
  assert.equal(adopted.status, 201, adopted.raw);
  const automation = adopted.json.adopted[0].automation;
  assert.equal(automation.workerCommandKind, "local_backup_registered");

  const runsBefore = countRows("runs", `company_id=${sqlValue(companyId)}`);
  const invocationsBefore = countRows("portable_workflow_invocations", `company_scope=${sqlValue(companyId)}`);
  const idempotencyKey = "api-legacy-local-run";
  const queued = await requestJson(
    "POST",
    `/api/mvp/registered-automations/${encodeURIComponent(automation.id)}/run?project_id=${companyId}`,
    { project_id: companyId, idempotency_key: idempotencyKey }
  );
  assert.equal(queued.status, 202, queued.raw);
  assert.equal(queued.json.schema, "aos.portable_workflow_trigger.v1");
  assert.equal(queued.json.queued, true);
  assert.equal(queued.json.provider_neutral, true);
  assert.equal(queued.json.workflow_id, "daily-backup-safety-check");
  assert.equal(queued.json.run.status, "queued");
  assert.equal(queued.json.run.company_id, companyId);
  assert.equal(queued.json.run.automation_id, automation.id);
  assert.equal(queued.json.run.automation_version_id, automation.currentVersionId);
  assert.equal(queued.json.source_trigger, "automation_os_ui");
  assert.equal(queued.json.operation_surface, "mac_local_worker");
  assert.equal(queued.json.worker_protocol, "mac_worker_polling_required");
  assert.equal(queued.json.external_action_executed, false);
  assert.equal(countRows("runs", `company_id=${sqlValue(companyId)}`), runsBefore + 1);
  assert.equal(countRows("portable_workflow_invocations", `company_scope=${sqlValue(companyId)}`), invocationsBefore + 1);

  const metadataRow = querySql<{ metadata_json: string }>(
    `SELECT metadata_json FROM runs WHERE id=${sqlValue(queued.json.run.id)} AND company_id=${sqlValue(companyId)} LIMIT 1`
  )[0];
  const metadata = JSON.parse(metadataRow.metadata_json) as Record<string, any>;
  assert.equal(metadata.read_only_stage, "reference_readback");
  assert.equal(metadata.effect_stage, undefined);
  assert.equal(metadata.portable_workflow_invocation.read_only_stage, "reference_readback");
  assert.equal(metadata.portable_workflow_invocation.effect_stage, undefined);
  assert.equal(metadata.portable_worker.mode, "read_only");

  const replay = await requestJson(
    "POST",
    `/api/mvp/registered-automations/${encodeURIComponent(automation.id)}/run?project_id=${companyId}`,
    { project_id: companyId },
    { "idempotency-key": idempotencyKey }
  );
  assert.equal(replay.status, 202, replay.raw);
  assert.equal(replay.json.run.id, queued.json.run.id);
  assert.equal(countRows("runs", `company_id=${sqlValue(companyId)}`), runsBefore + 1);
  assert.equal(countRows("portable_workflow_invocations", `company_scope=${sqlValue(companyId)}`), invocationsBefore + 1);

  const effectAttempt = await requestJson(
    "POST",
    `/api/mvp/registered-automations/${encodeURIComponent(automation.id)}/run?project_id=${companyId}`,
    { project_id: companyId, idempotency_key: "api-legacy-local-effect", effect_stage: "business_execute" }
  );
  assert.equal(effectAttempt.status, 400, effectAttempt.raw);
  assert.equal(effectAttempt.json.external_action_executed, false);
  assert.equal(countRows("runs", `company_id=${sqlValue(companyId)}`), runsBefore + 1);
  assert.equal(countRows("portable_workflow_invocations", `company_scope=${sqlValue(companyId)}`), invocationsBefore + 1);
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
  assert.equal(ownerDiagnostics.json.provider_registry.selected_provider, "aos.control_plane");
  assert.equal(ownerDiagnostics.json.provider_registry.provider_status, "available");
  assert.equal(ownerDiagnostics.json.provider_registry.external_action_allowed, false);
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
    { "if-match": "2" }
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

test("AOS catalog adopts all six flows and routes browser schedules through the portable Mac worker", async () => {
  seedMembership("api_company_aos", "api_aos_owner", "owner");
  setActor("api_aos_owner");

  const catalogRead = await requestJson("GET", "/api/v1/registered-automation-catalog");
  assert.equal(catalogRead.status, 200, catalogRead.raw);
  assert.equal(catalogRead.json.catalog.length, 6);
  assert.equal(catalogRead.json.external_action_executed, false);

  const adopted = await requestJson(
    "POST",
    "/api/v1/companies/api_company_aos/registered-automations/adopt",
    { enable_schedules: true },
    { "idempotency-key": "api-aos-adopt-all" }
  );
  assert.equal(adopted.status, 201, adopted.raw);
  assert.equal(adopted.json.adopted.length, 6);
  assert.equal(adopted.json.external_action_executed, false);
  assert.ok(adopted.json.adopted.every((item: any) => item.automation.companyId === "api_company_aos"));
  assert.ok(adopted.json.adopted.every((item: any) => item.adoption.externalActionAllowed === false));
  assert.equal(adopted.json.adopted.find((item: any) => item.sourceAutomationId === "automation-3").adoption.stages[2].id, "identity_admission");

  const registeredReadback = await requestJson("GET", "/api/mvp/registered-automations?project_id=api_company_aos");
  assert.equal(registeredReadback.status, 200, registeredReadback.raw);
  assert.deepEqual(
    registeredReadback.json.company_registration_projection.map((item: any) => item.canonicalWorkflowId),
    ["email-review-reply", "daily-ai-research-publish-run", "daily-backup-safety-check", "nisenprints-daily-product-canva-printify-etsy-pinterest", "obsidian-project-memory-audit"]
  );
  assert.ok(registeredReadback.json.company_registration_projection.every((item: any) => item.companyId === "api_company_aos" && item.automationId && item.revision));
  assert.equal(registeredReadback.json.external_action_executed, false);

  const list = await requestJson("GET", "/api/v1/companies/api_company_aos/automations");
  assert.equal(list.status, 200, list.raw);
  assert.equal(list.json.automations.length, 6);
  const webAutomations = list.json.automations.filter((item: any) => ["job_submit_registered", "daily_ai_registered", "nisenprints_registered"].includes(item.worker_command_kind));
  assert.equal(webAutomations.length, 3);
  assert.ok(webAutomations.every((item: any) => item.execution_mode === "portable_mac_worker_queue"));
  assert.ok(webAutomations.every((item: any) => item.scheduler_effect === "queues_portable_mac_worker"));
  assert.ok(webAutomations.every((item: any) => item.portable_dispatch?.worker_protocol === "mac_worker_polling_required"));

  const jobAutomation = adopted.json.adopted.find((item: any) => item.sourceAutomationId === "automation-3").automation;
  const trigger = await requestJson(
    "POST",
    `/api/v1/companies/api_company_aos/automations/${jobAutomation.id}/trigger`,
    { requested_stage: "identity_admission", companion_task_id: "api-companion-task-owner" },
    { "idempotency-key": "api-aos-identity-preflight" }
  );
  assert.equal(trigger.status, 202, trigger.raw);
  assert.equal(trigger.json.schema, "aos.portable_workflow_trigger.v1");
  assert.equal(trigger.json.portable, true);
  assert.equal(trigger.json.source_trigger, "aos_trigger_api");
  assert.equal(trigger.json.provider_neutral, true);
  assert.equal(trigger.json.external_action_executed, false);
  assert.equal(trigger.json.worker_protocol, "mac_worker_polling_required");
  assert.equal(trigger.json.run.company_id, "api_company_aos");
  assert.equal(trigger.json.registered_root_admission.first_class_root, true);
  assert.equal(trigger.json.registered_root_admission.owner, "automation_os_control_plane");
  assert.equal(trigger.json.registered_root_admission.run_id, trigger.json.run.id);
  assert.equal(trigger.json.registered_root_admission.external_action_executed, false);
  const triggerMetadata = querySql<{ metadata_json: string }>(
    `SELECT metadata_json FROM runs WHERE id=${sqlValue(trigger.json.run.id)} LIMIT 1`
  )[0];
  const triggerMetadataValue = JSON.parse(triggerMetadata.metadata_json) as {
    companion_task_id?: string;
    portable_workflow_invocation?: { companion_task_id?: string };
  };
  assert.equal(triggerMetadataValue.companion_task_id, "api-companion-task-owner");
  assert.equal(triggerMetadataValue.portable_workflow_invocation?.companion_task_id, "api-companion-task-owner");

  const replay = await requestJson(
    "POST",
    `/api/v1/companies/api_company_aos/automations/${jobAutomation.id}/trigger`,
    { requested_stage: "identity_admission", companion_task_id: "api-companion-task-owner" },
    { "idempotency-key": "api-aos-identity-preflight" }
  );
  assert.equal(replay.status, 202, replay.raw);
  assert.equal(replay.json.run.id, trigger.json.run.id);
  assert.equal(replay.json.portable, true);
  assert.equal(replay.json.queued, true);
});

test("service identity bootstrap is company-scoped and never returns secret material", async () => {
  seedMembership("api_company_service_identity", "api_service_owner", "owner");
  setActor("api_service_owner");
  const first = await requestJson(
    "POST",
    "/api/v1/companies/api_company_service_identity/service-identities",
    {},
    { "idempotency-key": "api-service-identity-bootstrap" }
  );
  assert.equal(first.status, 201, first.raw);
  assert.equal(first.json.schema, "aos.service_identity.v1");
  assert.equal(first.json.service_identity.role, "operator");
  assert.equal(first.json.secret_material_included, false);
  assert.match(first.json.service_identity.userId, /^aos_service_/u);
  assert.doesNotMatch(first.raw, /token|secret_value|password|api_key/iu);
  const readback = await requestJson(
    "GET",
    "/api/v1/companies/api_company_service_identity/service-identities"
  );
  assert.equal(readback.status, 200, readback.raw);
  assert.equal(readback.json.schema, "aos.service_identity_readback.v1");
  assert.equal(readback.json.configured, true);
  assert.equal(readback.json.exact_blocker, null);
  assert.deepEqual(readback.json.service_identity, {
    userId: first.json.service_identity.userId,
    companyId: "api_company_service_identity",
    role: "operator",
    kind: "service",
    status: "active",
    membershipStatus: "active"
  });
  assert.equal(readback.json.secret_material_included, false);
  assert.equal(readback.json.external_action_executed, false);
  assert.doesNotMatch(readback.raw, /token|secret_value|password|api_key/iu);
  const second = await requestJson(
    "POST",
    "/api/v1/companies/api_company_service_identity/service-identities",
    {},
    { "idempotency-key": "api-service-identity-bootstrap-replay" }
  );
  assert.equal(second.status, 201, second.raw);
  assert.equal(second.json.service_identity.userId, first.json.service_identity.userId);
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

function seedCompanyApproval(companyId: string, id: string, runId: string, status: "pending" | "approved", createdAt = new Date().toISOString()): void {
  execSql(`
    INSERT OR IGNORE INTO approvals (
      id, company_id, run_id, job_id, step_id, title, requested_by, status, priority,
      approval_group_id, action_kind, target_account_ref_id, payload_hash, policy_version,
      expires_at, decided_by_user_id, decision_revision, consumed_at, consumed_by_attempt_id,
      resource_locks_json, created_at, decided_at, decision_note
    ) VALUES (
      ${sqlValue(id)}, ${sqlValue(companyId)}, ${sqlValue(runId)}, NULL, NULL,
      ${sqlValue(id)}, ${sqlValue(`${companyId}_owner`)}, ${sqlValue(status)}, 'normal',
      ${sqlValue(`portable:${runId}`)}, 'business_execute', 'auth:profile2', ${sqlValue("a".repeat(64))},
      'policy-v1', '2030-01-01T00:00:00.000Z', NULL, 1, NULL, NULL, '[]',
      ${sqlValue(createdAt)}, NULL, NULL
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
): Promise<{ status: number; raw: string; json: any; headers: Record<string, string> }> {
  const response = await request(method, path, body, extraHeaders);
  return { status: response.status, raw: response.body, json: JSON.parse(response.body), headers: response.headers };
}

function request(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; headers: Record<string, string> }>((resolve, reject) => {
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
        resolve({
          status: this.statusCode,
          body: Buffer.concat(chunks).toString("utf8"),
          headers: Object.fromEntries([...headers.entries()].map(([name, value]) => [name, String(value)]))
        });
        return this;
      }
    };
    (app as unknown as { handle(req: unknown, res: unknown, next: (error?: unknown) => void): void }).handle(req, res, reject);
  });
}

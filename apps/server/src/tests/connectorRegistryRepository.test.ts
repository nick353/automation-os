import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "automation-os-connector-registry-"));
process.env.AUTOMATION_OS_DB = join(root, "automation-os.sqlite");
process.env.NODE_TEST_CONTEXT = "1";
const db = await import("../db/client.js");
const repository = await import("../codex/connectorRegistryRepository.js");
const { runPortableLocalWorkflowReadOnly } = await import("../runs/portableLocalWorkflow.js");

db.initDb();
const companyId = "connector-registry-company";
const actorUserId = "connector-registry-owner";
const timestamp = "2026-08-18T00:00:00.000Z";
db.insert("users", { id: actorUserId, auth_provider: "test", auth_subject: actorUserId, email: null, display_name: actorUserId, kind: "human", status: "active", created_at: timestamp, updated_at: timestamp });
db.insert("companies", { id: companyId, slug: companyId, name: companyId, status: "active", created_at: timestamp, updated_at: timestamp });
db.insert("company_memberships", { id: "connector-registry-membership", company_id: companyId, user_id: actorUserId, role: "owner", status: "active", created_at: timestamp, updated_at: timestamp });
db.insert("company_connection_account_refs", {
  id: "gmail-ref-1", company_id: companyId, platform: "gmail", account_ref: "owner@example.com", status: "verified",
  scopes_json: JSON.stringify(["read"]), expires_at: null, oauth_state: "connected", verification_status: "verified",
  last_verified_at: timestamp, reconnect_requested_at: null, revoked_at: null, revision: 1,
  created_at: timestamp, updated_at: timestamp
});

function registry(capturedAt = "2026-08-18T00:01:00.000Z") {
  return {
    schema: "aos_zeabur_codex_app_server_connector_registry.v1",
    capturedAt,
    source: "zeabur_service_exec",
    target: { projectId: "project", serviceId: "service", serviceName: "codex-app-server", environmentId: "environment" },
    appServer: { servicePresent: true, runtimeStatus: "running", codexLogin: "logged_in" },
    pluginRegistry: {
      installed: [{ id: "gmail@openai-curated", name: "gmail", installed: true, authStatus: "verified" }],
      available: [{ id: "airtable@openai-curated", name: "airtable", installed: false, authStatus: "unknown" }]
    },
    mcpRegistry: { configuredCount: 1, verified: true, names: ["gmail"] },
    connectorAuth: { gmail: "verified" },
    exactBlocker: null,
    secretMaterialIncluded: false
  };
}

test("company registry readback is persisted with a safe revision and no secret material", () => {
  const saved = repository.saveCompanyCodexRegistryReadback({ companyId, registry: { ...registry(), token: "must-not-persist" }, actorUserId });
  assert.equal(saved.companyId, companyId);
  assert.equal(saved.revision, 1);
  assert.equal(saved.registry.secretMaterialIncluded, false);
  assert.equal(JSON.stringify(saved.registry).includes("must-not-persist"), false);
  assert.equal(repository.getCompanyCodexRegistryReadback(companyId)?.revision, 1);
  assert.throws(() => repository.saveCompanyCodexRegistryReadback({ companyId, registry: registry("2026-08-17T23:59:00.000Z"), actorUserId }), /zeabur_registry_readback_stale/);
});

test("Gmail local canary stops at provider-call boundary after Zeabur placement is ready", () => {
  const readbackPath = join(root, "registry-readback.json");
  writeFileSync(readbackPath, `${JSON.stringify(registry())}\n`, { mode: 0o600 });
  chmodSync(readbackPath, 0o600);
  process.env.AUTOMATION_OS_CODEX_APP_SERVER_REGISTRY_READBACK_PATH = readbackPath;
  const result = runPortableLocalWorkflowReadOnly({
    workflowId: "email-review-reply",
    workerRole: "mac",
    companyId,
    gmailExecutionTarget: { connectionRefId: "gmail-ref-1", accountRef: "owner@example.com" }
  });
  assert.equal(result.status, "partial");
  assert.equal(result.exact_blocker, "gmail_provider_read_only_call_not_executed");
  assert.equal(result.external_action_executed, false);
  assert.equal(result.business_completion_verified, false);
  assert.equal(result.adapter_result.data_read, false);
});

test("a confirmed install updates its exact catalog entry without inventing auth or refreshing other observations", () => {
  const before = repository.normalizeCompanyCodexRegistryReadback(registry());
  const after = repository.registryAfterPluginInstall(before, "airtable@openai-curated");
  assert.equal(after.capturedAt, before.capturedAt);
  assert.deepEqual(after.connectorAuth, before.connectorAuth);
  assert.deepEqual(after.pluginRegistry.installed[0], before.pluginRegistry.installed[0]);
  assert.equal(after.pluginRegistry.installed[1]?.installed, true);
  assert.equal(after.pluginRegistry.installed[1]?.authStatus, "unknown");
  assert.equal(after.pluginRegistry.available.length, 0);
  assert.equal(before.pluginRegistry.available.length, 1);
  assert.equal(repository.registryAfterPluginInstall(after, "AIRTABLE@OPENAI-CURATED"), after);
  assert.throws(() => repository.registryAfterPluginInstall(before, "airtable@unrelated"), /zeabur_plugin_not_in_company_registry/);
});

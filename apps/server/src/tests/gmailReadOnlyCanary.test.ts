import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { buildGmailReadOnlyCanaryReadback, type GmailReadOnlyCanaryReadback } from "../connectors/gmailReadOnlyCanary.js";
import { getCodexCapabilities } from "../codex/capabilities.js";
import type { ZeaburConnectorRegistryReadback } from "../codex/zeaburConnectorRouting.js";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-gmail-canary-api-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");
process.env.AUTOMATION_OS_SECRET_DIR = join(tempRoot, "secrets");
const { app } = await import("../index.js");
const db = await import("../db/client.js");

function fixtureCapabilities() {
  const capabilities = getCodexCapabilities();
  capabilities.capabilities.mcp.state = { configured: true, enabled: true, verified: true, connected: false };
  capabilities.capabilities.appServer.state = { configured: true, enabled: true, verified: true, connected: false };
  capabilities.capabilities.plugins.push({
    id: "plugin:gmail-canary-test",
    name: "Gmail",
    path: "/tmp/plugins/gmail",
    status: "available_with_codex_runtime",
    kind: "plugin",
    state: { configured: true, enabled: true, verified: true, connected: false }
  });
  return capabilities;
}

function verifiedZeaburRegistry(): ZeaburConnectorRegistryReadback {
  return {
    schema: "aos_zeabur_codex_app_server_connector_registry.v1",
    capturedAt: new Date().toISOString(),
    source: "zeabur_service_exec",
    target: { projectId: "project", serviceId: "service", serviceName: "codex-app-server", environmentId: "environment" },
    appServer: { servicePresent: true, runtimeStatus: "running", codexLogin: "logged_in" },
    pluginRegistry: { installed: [{ id: "gmail", name: "Gmail", installed: true, authStatus: "verified" }], available: [] },
    mcpRegistry: { configuredCount: 0, verified: false, names: [] },
    connectorAuth: { gmail: "verified" },
    exactBlocker: null,
    secretMaterialIncluded: false
  };
}

test("Gmail read-only canary stops without a company connection ref and has no effect", () => {
  const readback = buildGmailReadOnlyCanaryReadback({
    companyId: "company-a",
    capabilities: fixtureCapabilities(),
    companyConnectionRefs: []
  });

  assert.equal(readback.status, "blocked");
  assert.equal(readback.exactBlocker, "gmail_company_connection_ref_missing");
  assert.equal(readback.externalActionExecuted, false);
  assert.equal(readback.dataRead, false);
  assert.equal(readback.dataPersisted, false);
  assert.equal(readback.providerReceipt, null);
});

test("Gmail read-only canary admits the provider-call boundary only after fresh company and runtime verification", () => {
  const readback = buildGmailReadOnlyCanaryReadback({
    companyId: "company-a",
    capabilities: fixtureCapabilities(),
    companyConnectionRefs: [{
      platform: "gmail",
      status: "verified",
      oauth_state: "connected",
      verification_status: "verified"
    }]
  });

  assert.equal(readback.status, "ready_for_provider_call");
  assert.equal(readback.exactBlocker, null);
  assert.equal(readback.selectedTool?.kind, "plugin");
  assert.equal(readback.externalActionExecuted, false);
  assert.equal(readback.dataRead, false);
  assert.equal(readback.dataPersisted, false);
  assert.equal(readback.reconciliation.status, "not_started");
});

test("Gmail Plugin registry admission does not require an MCP capability", () => {
  const capabilities = getCodexCapabilities();
  const readback = buildGmailReadOnlyCanaryReadback({
    companyId: "company-a",
    capabilities,
    companyConnectionRefs: [{
      platform: "gmail",
      status: "verified",
      oauth_state: "connected",
      verification_status: "verified"
    }],
    zeaburConnectorRegistry: verifiedZeaburRegistry()
  });

  assert.equal(readback.status, "ready_for_provider_call");
  assert.equal(readback.exactBlocker, null);
  assert.equal(readback.transport, "codex_app_server_plugin");
  assert.equal(readback.selectedTool?.kind, "plugin");
  assert.equal(readback.selectedTool?.label.toLowerCase(), "gmail");
  assert.equal(readback.externalActionExecuted, false);
  assert.equal(readback.dataRead, false);
});

test("Gmail read-only canary API is company-scoped and returns no secret or provider data", async () => {
  db.initDb();
  db.resetDemoData();
  const now = db.nowIso();
  db.upsert("users", { id: "user_local_owner", auth_provider: "test", auth_subject: "user_local_owner", email: null, display_name: "Canary owner", kind: "human", status: "active", created_at: now, updated_at: now });
  db.upsert("companies", { id: "company-canary-api", slug: "company-canary-api", name: "Canary API", status: "active", created_at: now, updated_at: now });
  db.upsert("company_memberships", { id: "membership-canary-api", company_id: "company-canary-api", user_id: "user_local_owner", role: "owner", status: "active", created_at: now, updated_at: now });

  const response = await requestJson("GET", "/api/v1/companies/company-canary-api/connectors/gmail/read-only-canary");
  assert.equal(response.status, 200);
  const body = JSON.parse(response.body) as { ok: boolean; readback: GmailReadOnlyCanaryReadback; external_action_executed: boolean; secret_material_included: boolean; company_scope: { company_id: string } };
  assert.equal(body.ok, true);
  assert.equal(body.readback.status, "blocked");
  assert.equal(body.readback.exactBlocker, "gmail_company_connection_ref_missing");
  assert.equal(body.external_action_executed, false);
  assert.equal(body.secret_material_included, false);
  assert.equal(body.company_scope.company_id, "company-canary-api");
  assert.doesNotMatch(response.body, /access_token|refresh_token|password|Bearer\s+\S+/iu);
});

function requestJson(method: string, path: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = Readable.from([]) as NodeJS.ReadableStream & { method?: string; url?: string; headers?: Record<string, string> };
    req.method = method;
    req.url = path;
    req.headers = { "content-type": "application/json", "content-length": "0" };
    const chunks: Buffer[] = [];
    const res = {
      statusCode: 200,
      setHeader() { return this; },
      getHeader() { return undefined; },
      removeHeader() { return undefined; },
      end(chunk?: string | Buffer) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        resolve({ status: this.statusCode, body: Buffer.concat(chunks).toString("utf8") });
        return this;
      }
    };
    (app as unknown as { handle(req: unknown, res: unknown, next: (error?: unknown) => void): void }).handle(req, res, reject);
  });
}

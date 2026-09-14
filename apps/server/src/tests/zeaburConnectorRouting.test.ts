import assert from "node:assert/strict";
import test from "node:test";
import { buildConnectorExecutionPlacement, canBootstrapInstalledPluginAuth, sanitizeZeaburConnectorRegistryReadback, type ZeaburConnectorRegistryReadback } from "../codex/zeaburConnectorRouting.js";

function fixture(status: "verified" | "unverified" = "verified"): ZeaburConnectorRegistryReadback {
  return {
    schema: "aos_zeabur_codex_app_server_connector_registry.v1",
    capturedAt: "2026-08-18T00:00:00.000Z",
    source: "zeabur_service_exec",
    target: { projectId: "project", serviceId: "service", serviceName: "codex-app-server", environmentId: "environment" },
    appServer: { servicePresent: true, runtimeStatus: "running", codexLogin: "logged_in" },
    pluginRegistry: {
      installed: [
        { id: "gmail@openai-curated", name: "gmail", installed: true, authStatus: status },
        { id: "supabase@openai-curated", name: "supabase", installed: true, authStatus: status }
      ],
      available: []
    },
    mcpRegistry: { configuredCount: 0, verified: false, names: [] },
    connectorAuth: { gmail: status, supabase: status },
    exactBlocker: status === "verified" ? null : "zeabur_connector_auth_not_verified",
    secretMaterialIncluded: false
  };
}

test("verified Zeabur Plugin owns connector execution while Mac remains Chrome Profile 2", () => {
  const placement = buildConnectorExecutionPlacement({
    connector: "gmail",
    zeabur: fixture(),
    companyConnectionVerified: true
  });
  assert.equal(placement.owner, "zeabur_codex_app_server");
  assert.equal(placement.status, "ready");
  assert.equal(placement.macWorkerDefaultSurface, "chrome_plugin_profile2");
  assert.equal(placement.fallbackPolicy, "explicit_only");
  assert.equal(placement.externalActionExecuted, false);
});

test("unverified Zeabur connector does not implicitly fall back to Mac", () => {
  const blocked = buildConnectorExecutionPlacement({
    connector: "supabase",
    zeabur: fixture("unverified"),
    companyConnectionVerified: true
  });
  assert.equal(blocked.owner, "none");
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.exactBlocker, "zeabur_connector_auth_not_verified");

  const explicit = buildConnectorExecutionPlacement({
    connector: "supabase",
    zeabur: fixture("unverified"),
    companyConnectionVerified: true,
    explicitMacConnectorFallback: true
  });
  assert.equal(explicit.owner, "mac_worker_explicit_connector_fallback");
  assert.equal(explicit.status, "explicit_fallback");
  assert.equal(explicit.externalActionExecuted, false);
});

test("connector-specific auth does not let another Plugin's blocker stop Gmail", () => {
  const registry = fixture("verified");
  registry.connectorAuth = { gmail: "verified", supabase: "unverified" };
  registry.exactBlocker = "zeabur_connector_auth_not_verified";
  const placement = buildConnectorExecutionPlacement({ connector: "gmail", zeabur: registry, companyConnectionVerified: true });
  assert.equal(placement.status, "ready");
  assert.equal(placement.owner, "zeabur_codex_app_server");
});

test("installed Plugin auth bootstrap can proceed without clearing execution blocker", () => {
  const registry = fixture("unverified");
  assert.equal(canBootstrapInstalledPluginAuth({ registry, pluginName: "gmail" }), true);
  assert.equal(canBootstrapInstalledPluginAuth({ registry, pluginName: "missing-plugin" }), false);
  assert.equal(canBootstrapInstalledPluginAuth({ registry: { ...registry, exactBlocker: "zeabur_codex_app_server_login_not_verified" }, pluginName: "gmail" }), false);
});

test("Zeabur CLI authentication failure remains a hard placement blocker", () => {
  const registry = { ...fixture(), exactBlocker: "zeabur_cli_authentication_unavailable" };
  const placement = buildConnectorExecutionPlacement({ connector: "gmail", zeabur: registry, companyConnectionVerified: true });
  assert.equal(placement.status, "blocked");
  assert.equal(placement.owner, "none");
  assert.equal(placement.exactBlocker, "zeabur_cli_authentication_unavailable");
});

test("company registry sanitizer preserves Codex Server auth metadata without secrets", () => {
  const registry = sanitizeZeaburConnectorRegistryReadback({
    schema: "aos_zeabur_codex_app_server_connector_registry.v1",
    capturedAt: "2026-08-18T00:00:00.000Z",
    source: "zeabur_service_exec",
    target: { projectId: "project", serviceId: "service", serviceName: "codex-app-server", environmentId: "environment" },
    appServer: { servicePresent: true, runtimeStatus: "running", codexLogin: "logged_in" },
    pluginRegistry: {
      installed: [],
      available: [{ pluginId: "linear@openai-curated", name: "linear", marketplaceName: "openai-curated", installed: false, authStatus: "unknown", authPolicy: "ON_INSTALL" }]
    },
    mcpRegistry: { configuredCount: 0, verified: false, names: [] },
    connectorAuth: {},
    exactBlocker: null,
    secretMaterialIncluded: false
  });
  assert.deepEqual(registry.pluginRegistry.available[0], {
    id: "linear@openai-curated",
    name: "linear",
    installed: false,
    authStatus: "unknown",
    marketplaceName: "openai-curated",
    authPolicy: "ON_INSTALL"
  });
  assert.equal(registry.secretMaterialIncluded, false);
});

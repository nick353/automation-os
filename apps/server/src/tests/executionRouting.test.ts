import assert from "node:assert/strict";
import test from "node:test";
import { listTrustedBridgeActions } from "../bridge/trustedBridge.js";
import { buildCapabilityRouterSnapshot } from "../codex/capabilityRouter.js";
import { buildExecutionRoutingSnapshot, inferExecutionRoutingSource } from "../codex/executionRouting.js";
import type { CodexCapabilitiesSummary } from "../codex/capabilities.js";

test("execution routing chooses Codex server as controller and preserves the strongest browser lane", () => {
  const capabilities = fixtureCapabilities();
  const router = buildCapabilityRouterSnapshot({
    command: "このYouTube https://www.youtube.com/watch?v=dQw4w9WgXcQ を調べて",
    capabilities,
    bridgeActions: listTrustedBridgeActions()
  });
  const routing = buildExecutionRoutingSnapshot({
    command: "このYouTube https://www.youtube.com/watch?v=dQw4w9WgXcQ を調べて",
    source: "scheduler",
    capabilities,
    capabilityRouter: router
  });

  assert.equal(routing.source, "scheduler");
  assert.equal(routing.controller.name, "automation_os_api");
  assert.equal(routing.controller.status, "inventory_only");
  assert.equal(routing.selectedRouteId, "web_url_capture");
  assert.equal(routing.executionSurface, "browser_lane");
  assert.equal(routing.routeAuthority, "catalog");
  assert.equal(routing.routeProof, "read_only");
  assert.equal(routing.fallbackReason, "blocked:chrome_extension_required");
});

test("execution routing keeps the automation_os_api controller even when MCP is connected", () => {
  const capabilities = fixtureCapabilities();
  capabilities.capabilities.mcp.state.connected = true;
  capabilities.capabilities.mcp.state.enabled = true;
  capabilities.capabilities.mcp.state.verified = true;
  const router = buildCapabilityRouterSnapshot({
    command: "このYouTube https://www.youtube.com/watch?v=dQw4w9WgXcQ を調べて",
    capabilities,
    bridgeActions: listTrustedBridgeActions()
  });
  const routing = buildExecutionRoutingSnapshot({
    command: "このYouTube https://www.youtube.com/watch?v=dQw4w9WgXcQ を調べて",
    source: "scheduler",
    capabilities,
    capabilityRouter: router
  });

  assert.equal(routing.controller.name, "automation_os_api");
});

test("execution routing blocks browser adapters before any worker command can run", () => {
  const capabilities = fixtureCapabilities();
  const router = buildCapabilityRouterSnapshot({
    command: "safe local smoke",
    capabilities,
    bridgeActions: listTrustedBridgeActions()
  });
  const routing = buildExecutionRoutingSnapshot({
    command: "safe local smoke",
    source: "manual",
    selectedAdapter: "playwright_cli",
    capabilities,
    capabilityRouter: router
  });

  assert.equal(routing.exactBlocker, "chrome_extension_required");
  assert.match(routing.evidence.join(" "), /adapter=playwright_cli/);
  assert.match(routing.evidence.join(" "), /adapter_policy=chrome_extension_only/);
});

test("execution routing blocks browser_use_cli with the same Chrome extension gate", () => {
  const capabilities = fixtureCapabilities();
  const router = buildCapabilityRouterSnapshot({
    command: "safe local smoke",
    capabilities,
    bridgeActions: listTrustedBridgeActions()
  });
  const routing = buildExecutionRoutingSnapshot({
    command: "safe local smoke",
    source: "manual",
    selectedAdapter: "browser_use_cli",
    capabilities,
    capabilityRouter: router
  });

  assert.equal(routing.phase, "route_decision");
  assert.equal(routing.exactBlocker, "chrome_extension_required");
  assert.match(routing.evidence.join(" "), /adapter=browser_use_cli/);
  assert.match(routing.evidence.join(" "), /adapter_policy=chrome_extension_only/);
});

test("execution routing requires a decision fingerprint before route readback", () => {
  const capabilities = fixtureCapabilities();
  const routing = buildExecutionRoutingSnapshot({
    command: "safe local smoke",
    source: "manual",
    phase: "route_readback",
    capabilities
  });

  assert.equal(routing.exactBlocker, "route_decision_missing");
});

test("execution routing source inference keeps scheduler and create view paths separate", () => {
  assert.equal(
    inferExecutionRoutingSource({ registered_workflow_start: { source: "scheduler", runnerKind: "daily_ai_registered" } }),
    "scheduler"
  );
  assert.equal(
    inferExecutionRoutingSource({ registered_workflow_start: { source: "manual", runnerKind: "daily_ai_registered" } }),
    "manual"
  );
  assert.equal(
    inferExecutionRoutingSource({ create_session_source: "create_view" }),
    "create_view"
  );
});

function fixtureCapabilities(): CodexCapabilitiesSummary {
  const generatedAt = "2026-06-20T00:00:00.000Z";
  return {
    generatedAt,
    roots: {
      codexSkills: { path: "/tmp/skills", exists: true },
      agentSkills: { path: "/tmp/agent-skills", exists: true },
      pluginsCache: { path: "/tmp/plugins", exists: false },
      automations: { path: "/tmp/automations", exists: false }
    },
    summary: {
      skills: 4,
      agentSkills: 0,
      plugins: 0,
      automations: 0,
      mcp: 0
    },
    capabilities: {
      browser: { id: "browser-in-app", name: "Browser / In-App Browser", path: "plugin://Browser", status: "requires_bridge", kind: "browser_bridge", state: { configured: true, enabled: false, verified: false, connected: false } },
      chrome: { id: "chrome-extension", name: "Chrome extension lane", path: "plugin://Chrome", status: "requires_bridge", kind: "browser_bridge", state: { configured: true, enabled: false, verified: false, connected: false } },
      automationOsApi: { id: "automation-os-api", name: "Automation OS local API server", path: "http://127.0.0.1", status: "available", kind: "automation_os_api", state: { configured: true, enabled: true, verified: true, connected: true } },
      mcp: { id: "mcp-tools", name: "MCP tools exposed by Codex runtime", path: "codex-runtime://mcp", status: "available_with_codex_runtime", kind: "mcp", state: { configured: true, enabled: true, verified: true, connected: false } },
      cli: { id: "codex-cli", name: "Codex CLI", path: "command://codex", status: "available_with_codex_runtime", kind: "cli", state: { configured: true, enabled: true, verified: true, connected: true } },
      appServer: { id: "codex-app-server", name: "Codex App Server", path: "codex-app-server://stdio", status: "missing", kind: "codex_app_server", state: { configured: false, enabled: false, verified: false, connected: false } },
      skills: [],
      plugins: [],
      automations: []
    },
    notes: []
  };
}

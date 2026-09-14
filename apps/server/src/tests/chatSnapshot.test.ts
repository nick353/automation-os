import assert from "node:assert/strict";
import test from "node:test";
import { serializeAutomationOsChatSnapshot, buildChatPluginConnections } from "../codex/chatSnapshot.js";
import { missingZeaburConnectorRegistryReadback } from "../codex/zeaburConnectorRouting.js";

test("chat snapshot stays valid and bounded when project history is large", () => {
  const snapshot = {
    capturedAt: "2026-08-03T00:00:00.000Z",
    source: "automation_os_control_plane_readback",
    companyScope: ["project-a"],
    companies: [{ id: "project-a", name: "Project A", status: "active", role: "owner" }],
    automations: Array.from({ length: 160 }, (_, index) => ({ id: `automation-${index}`, company_id: "project-a", name: "A".repeat(700), goal: "G".repeat(900), status: "draft" })),
    schedules: Array.from({ length: 160 }, (_, index) => ({ id: `schedule-${index}`, company_id: "project-a", automation_id: `automation-${index}`, expression: "0 9 * * *" })),
    runs: Array.from({ length: 160 }, (_, index) => ({ id: `run-${index}`, company_id: "project-a", name: "R".repeat(700), objective: "O".repeat(900), status: "blocked" })),
    approvals: Array.from({ length: 160 }, (_, index) => ({ id: `approval-${index}`, run_id: `run-${index}`, title: "P".repeat(700), status: "pending" })),
    presentationProfiles: Array.from({ length: 80 }, (_, index) => ({ id: `profile-${index}`, explanation: "E".repeat(1600), widgets: ["kpi", "timeline"] })),
    registeredWorkflows: Array.from({ length: 160 }, (_, index) => ({ id: `workflow-${index}`, name: "W".repeat(700), next_action_label: "履歴で確認" })),
    worker: { status: "blocked", exact_blocker: "stored_postgres_secret_invalid_url", external_action_executed: false },
    browserUse: { status: "verified", surface: "browser_use_cli" },
    toolPreference: { selected: { id: "gmail@openai-curated", status: "ready" }, connectorExecution: { owner: "zeabur_codex_app_server", status: "ready" } },
    pluginConnections: [{ companyId: "project-a", installed: [{ id: "gmail", authStatus: "verified" }, { id: "canva", authStatus: "unverified" }] }],
    freshness: { stalePolicy: "show_stale_and_exact_blocker" },
    boundaries: { externalActionExecuted: false, approvalRequired: true, secretsIncluded: false, rawPrivatePathsIncluded: false }
  };

  const serialized = serializeAutomationOsChatSnapshot(snapshot);
  assert.ok(Buffer.byteLength(serialized, "utf8") <= 64 * 1024);
  const parsed = JSON.parse(serialized) as Record<string, unknown>;
  const freshness = parsed.freshness as Record<string, unknown>;
  assert.equal(freshness.snapshotTruncated, true);
  assert.equal(freshness.snapshotTier, "minimal");
  assert.equal((parsed.boundaries as Record<string, unknown>).secretsIncluded, false);
  assert.equal((parsed.worker as Record<string, unknown>).exact_blocker, "stored_postgres_secret_invalid_url");
  assert.deepEqual(parsed.toolPreference, snapshot.toolPreference);
  assert.deepEqual(parsed.pluginConnections, snapshot.pluginConnections);
});

test("plugin Chat context is company-scoped and omits account identifiers and scopes", () => {
  const registry = missingZeaburConnectorRegistryReadback();
  registry.pluginRegistry.installed = [{ id: "gmail", name: "Gmail", installed: true, authStatus: "verified" }];
  const result = buildChatPluginConnections("company-one", registry, [
    { companyId: "company-one", platform: "gmail", status: "active", accountRef: "private-account", scopes: ["private-scope"], verificationStatus: "verified" },
    { companyId: "foreign", platform: "canva", accountRef: "foreign-account" }
  ] as any);
  assert.equal(result.installed.length, 1);
  assert.equal(result.companyConnections.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /private-account|private-scope|foreign-account/);
  assert.equal(result.verificationScope, "registry_and_company_refs_only_not_a_new_provider_call");
});

test("small chat snapshot keeps the complete readback and remains valid JSON", () => {
  const snapshot = { capturedAt: "2026-08-03T00:00:00.000Z", source: "test", companyScope: ["project-a"], automations: [{ id: "automation-a" }], schedules: [], runs: [], approvals: [], presentationProfiles: [], registeredWorkflows: [], freshness: {}, boundaries: { secretsIncluded: false } };
  const parsed = JSON.parse(serializeAutomationOsChatSnapshot(snapshot)) as Record<string, unknown>;
  const freshness = parsed.freshness as Record<string, unknown>;
  assert.equal(freshness.snapshotTruncated, false);
  assert.equal((parsed.automations as Array<Record<string, unknown>>)[0].id, "automation-a");
});

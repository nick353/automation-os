import assert from "node:assert/strict";
import test from "node:test";
import {
  AOS_CONTROL_PLANE_PROVIDER,
  AOS_PROVIDER_CONTRACT,
  AutomationProviderRegistryError,
  AutomationProviderRegistryV1,
  buildAutomationProviderMetadata,
  createNoEffectControlPlaneProvider,
  normalizeAutomationProviderId
} from "../providers/automationProvider.js";

test("provider selection defaults to an available AOS control-plane provider", () => {
  const metadata = buildAutomationProviderMetadata(undefined);
  assert.equal(metadata.selected_provider, AOS_CONTROL_PLANE_PROVIDER);
  assert.equal(metadata.provider_kind, "deterministic");
  assert.equal(metadata.provider_status, "available");
  assert.equal(metadata.execution_authority, "automation_os_control_plane");
  assert.equal(metadata.external_action_allowed, false);
});

test("LLM provider names are metadata-only until an adapter is registered", () => {
  const metadata = buildAutomationProviderMetadata("claude");
  assert.equal(metadata.requested_provider, "claude");
  assert.equal(metadata.selected_provider, "claude");
  assert.equal(metadata.provider_kind, "llm");
  assert.equal(metadata.provider_status, "adapter_not_registered");
  assert.equal(metadata.execution_authority, "automation_os_control_plane");
  assert.equal(normalizeAutomationProviderId("bad provider"), null);
});

test("the provider registry defaults to a deterministic no-effect AOS adapter", async () => {
  const registry = new AutomationProviderRegistryV1();
  const readback = registry.readback();
  assert.equal(readback.schema, "aos.execution_provider_registry.v1");
  assert.equal(readback.selected_provider, AOS_CONTROL_PLANE_PROVIDER);
  assert.equal(readback.provider_status, "available");
  assert.equal(readback.execution_authority, "automation_os_control_plane");
  assert.equal(readback.codex_is_not_authority, true);
  assert.equal(readback.external_action_allowed, false);

  const resolved = registry.require();
  assert.equal(resolved.adapter.id, AOS_CONTROL_PLANE_PROVIDER);
  assert.deepEqual(await resolved.adapter.execute({}), {
    provider: AOS_CONTROL_PLANE_PROVIDER,
    status: "no_effect",
    external_action_executed: false
  });
});

test("a requested unregistered provider fails closed without silent Codex fallback", () => {
  const registry = new AutomationProviderRegistryV1();
  const readback = registry.readback("claude");
  assert.equal(readback.selected_provider, null);
  assert.equal(readback.provider_status, "adapter_not_registered");
  assert.equal(readback.exact_blocker, "provider_adapter_not_registered");
  assert.equal(readback.external_action_allowed, false);
  assert.equal(registry.resolve("claude"), null);
  assert.throws(() => registry.require("claude"), (error: unknown) => {
    return error instanceof AutomationProviderRegistryError && error.code === "provider_adapter_not_registered";
  });
});

test("an explicitly registered Claude adapter is selectable while AOS keeps authority", () => {
  const registry = new AutomationProviderRegistryV1();
  registry.register({
    contract: AOS_PROVIDER_CONTRACT,
    id: "claude",
    kind: "llm",
    async prepare() { return { status: "prepared" }; },
    async execute() { return { status: "provider_only", external_action_executed: false }; },
    async readback() { return { status: "available" }; }
  });
  const readback = registry.readback("claude");
  assert.equal(readback.selected_provider, "claude");
  assert.equal(readback.provider_kind, "llm");
  assert.equal(readback.provider_status, "available");
  assert.equal(readback.execution_authority, "automation_os_control_plane");
  assert.equal(readback.external_action_allowed, false);
  assert.equal(registry.require("claude").adapter.id, "claude");
});

test("provider registry rejects duplicate or malformed adapters", () => {
  const registry = new AutomationProviderRegistryV1([createNoEffectControlPlaneProvider()]);
  assert.throws(() => registry.register(createNoEffectControlPlaneProvider()), /provider_adapter_duplicate:aos\.control_plane/);
  assert.throws(() => registry.register({
    ...createNoEffectControlPlaneProvider(),
    id: "bad provider"
  }), /provider_adapter_id_invalid/);
});

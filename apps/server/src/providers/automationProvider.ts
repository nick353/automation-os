/**
 * Provider-neutral execution port for AOS.
 *
 * The control plane owns company scope, scheduling, leases, approvals, and
 * terminal readback. An LLM provider is only an optional bounded adapter below
 * that boundary. The deterministic control-plane provider is deliberately
 * usable when Codex, Claude, or every other LLM is unavailable.
 */

export const AOS_CONTROL_PLANE_PROVIDER = "aos.control_plane" as const;
export const AOS_PROVIDER_CONTRACT = "aos.execution_provider.v1" as const;
export const AOS_PROVIDER_REGISTRY_SCHEMA = "aos.execution_provider_registry.v1" as const;

export type AutomationProviderKind = "deterministic" | "llm" | "other";
export type AutomationProviderStatus = "available" | "adapter_not_registered";

export type AutomationProviderAdapterV1<Input = Record<string, unknown>, Output = Record<string, unknown>> = {
  contract: typeof AOS_PROVIDER_CONTRACT;
  id: string;
  kind: AutomationProviderKind;
  prepare(input: Input): Promise<Record<string, unknown>>;
  execute(input: Input): Promise<Output>;
  readback(input: Input): Promise<Record<string, unknown>>;
};

export type AutomationProviderMetadataV1 = {
  contract: typeof AOS_PROVIDER_CONTRACT;
  requested_provider: string | null;
  selected_provider: string;
  provider_kind: AutomationProviderKind;
  provider_status: AutomationProviderStatus;
  execution_authority: "automation_os_control_plane";
  external_action_allowed: false;
};

export type AutomationProviderRegistryReadbackV1 = {
  schema: typeof AOS_PROVIDER_REGISTRY_SCHEMA;
  requested_provider: string | null;
  selected_provider: string | null;
  provider_kind: AutomationProviderKind | null;
  provider_status: AutomationProviderStatus;
  available_providers: Array<{ id: string; kind: AutomationProviderKind }>;
  execution_authority: "automation_os_control_plane";
  codex_is_not_authority: true;
  external_action_allowed: false;
  exact_blocker: string | null;
};

export type AutomationProviderResolutionV1 = {
  requested_provider: string | null;
  selected_provider: string;
  adapter: AutomationProviderAdapterV1;
  readback: AutomationProviderRegistryReadbackV1;
};

export class AutomationProviderRegistryError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "AutomationProviderRegistryError";
  }
}

const providerIdPattern = /^[a-z][a-z0-9._:-]{0,80}$/;

export function normalizeAutomationProviderId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized && providerIdPattern.test(normalized) ? normalized : null;
}

export function buildAutomationProviderMetadata(value: unknown): AutomationProviderMetadataV1 {
  const requested = normalizeAutomationProviderId(value);
  const selected = requested ?? AOS_CONTROL_PLANE_PROVIDER;
  const providerKind: AutomationProviderKind = selected === AOS_CONTROL_PLANE_PROVIDER
    ? "deterministic"
    : ["codex", "claude", "gemini", "openai"].includes(selected)
      ? "llm"
      : "other";
  return {
    contract: AOS_PROVIDER_CONTRACT,
    requested_provider: requested,
    selected_provider: selected,
    provider_kind: providerKind,
    provider_status: selected === AOS_CONTROL_PLANE_PROVIDER ? "available" : "adapter_not_registered",
    execution_authority: "automation_os_control_plane",
    external_action_allowed: false
  };
}

/**
 * Provider registry owned by AOS.  Registration is explicit and in-memory;
 * it never persists credentials, grants a workflow approval, or authorizes an
 * external effect.  A requested but unregistered provider fails closed rather
 * than silently falling back to Codex or the deterministic adapter.
 */
export class AutomationProviderRegistryV1 {
  private readonly adapters = new Map<string, AutomationProviderAdapterV1>();

  constructor(adapters: readonly AutomationProviderAdapterV1[] = [createNoEffectControlPlaneProvider()]) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: AutomationProviderAdapterV1): void {
    if (!adapter || adapter.contract !== AOS_PROVIDER_CONTRACT) {
      throw new AutomationProviderRegistryError("provider_adapter_contract_invalid");
    }
    const normalizedId = normalizeAutomationProviderId(adapter.id);
    if (!normalizedId || normalizedId !== adapter.id) {
      throw new AutomationProviderRegistryError("provider_adapter_id_invalid");
    }
    if (this.adapters.has(normalizedId)) {
      throw new AutomationProviderRegistryError(`provider_adapter_duplicate:${normalizedId}`);
    }
    this.adapters.set(normalizedId, adapter);
  }

  list(): Array<{ id: string; kind: AutomationProviderKind }> {
    return [...this.adapters.values()]
      .map((adapter) => ({ id: adapter.id, kind: adapter.kind }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  resolve(value: unknown): AutomationProviderResolutionV1 | null {
    const requested = value === undefined || value === null || (typeof value === "string" && value.trim() === "")
      ? null
      : normalizeAutomationProviderId(value);
    if (value !== undefined && value !== null && !(typeof value === "string" && value.trim() === "") && !requested) {
      return null;
    }
    const selected = requested ?? AOS_CONTROL_PLANE_PROVIDER;
    const adapter = this.adapters.get(selected);
    if (!adapter) return null;
    const readback = this.readback(value);
    return {
      requested_provider: requested,
      selected_provider: selected,
      adapter,
      readback
    };
  }

  readback(value: unknown = undefined): AutomationProviderRegistryReadbackV1 {
    const requested = value === undefined || value === null || (typeof value === "string" && value.trim() === "")
      ? null
      : normalizeAutomationProviderId(value);
    if (value !== undefined && value !== null && !(typeof value === "string" && value.trim() === "") && !requested) {
      return this.blockedReadback(null, "provider_id_invalid");
    }
    const selected = requested ?? AOS_CONTROL_PLANE_PROVIDER;
    const adapter = this.adapters.get(selected);
    if (!adapter) return this.blockedReadback(requested, "provider_adapter_not_registered");
    return {
      schema: AOS_PROVIDER_REGISTRY_SCHEMA,
      requested_provider: requested,
      selected_provider: selected,
      provider_kind: adapter.kind,
      provider_status: "available",
      available_providers: this.list(),
      execution_authority: "automation_os_control_plane",
      codex_is_not_authority: true,
      external_action_allowed: false,
      exact_blocker: null
    };
  }

  require(value: unknown = undefined): AutomationProviderResolutionV1 {
    const readback = this.readback(value);
    if (readback.exact_blocker || !readback.selected_provider) {
      throw new AutomationProviderRegistryError(readback.exact_blocker ?? "provider_adapter_not_registered");
    }
    const adapter = this.adapters.get(readback.selected_provider);
    if (!adapter) throw new AutomationProviderRegistryError("provider_adapter_not_registered");
    return {
      requested_provider: readback.requested_provider,
      selected_provider: readback.selected_provider,
      adapter,
      readback
    };
  }

  private blockedReadback(requested: string | null, exactBlocker: string): AutomationProviderRegistryReadbackV1 {
    return {
      schema: AOS_PROVIDER_REGISTRY_SCHEMA,
      requested_provider: requested,
      selected_provider: null,
      provider_kind: null,
      provider_status: "adapter_not_registered",
      available_providers: this.list(),
      execution_authority: "automation_os_control_plane",
      codex_is_not_authority: true,
      external_action_allowed: false,
      exact_blocker: exactBlocker
    };
  }
}

/** Deterministic control-plane adapter; every operation is explicitly no-effect. */
export function createNoEffectControlPlaneProvider(): AutomationProviderAdapterV1 {
  return {
    contract: AOS_PROVIDER_CONTRACT,
    id: AOS_CONTROL_PLANE_PROVIDER,
    kind: "deterministic",
    async prepare() {
      return { provider: AOS_CONTROL_PLANE_PROVIDER, status: "prepared", external_action_executed: false };
    },
    async execute() {
      return { provider: AOS_CONTROL_PLANE_PROVIDER, status: "no_effect", external_action_executed: false };
    },
    async readback() {
      return { provider: AOS_CONTROL_PLANE_PROVIDER, status: "readback", external_action_executed: false };
    }
  };
}

export const defaultAutomationProviderRegistry = new AutomationProviderRegistryV1();

import { existsSync, readFileSync } from "node:fs";

export const ZEABUR_CONNECTOR_REGISTRY_READBACK_SCHEMA = "aos_zeabur_codex_app_server_connector_registry.v1" as const;

export type ConnectorId = "gmail" | "supabase" | string;
export type ConnectorAuthStatus = "verified" | "unverified" | "missing" | "unknown";
export type ZeaburPluginAuthPolicy = "ON_INSTALL" | "ON_USE";
export type ConnectorExecutionOwner =
  | "zeabur_codex_app_server"
  | "mac_worker_chrome_plugin_profile2"
  | "mac_worker_explicit_connector_fallback"
  | "none";

export type ZeaburPluginRegistryEntry = {
  id: string;
  name: string;
  installed: boolean;
  authStatus: ConnectorAuthStatus;
  marketplaceName?: string;
  authPolicy?: ZeaburPluginAuthPolicy | null;
};

export type ZeaburConnectorRegistryReadback = {
  schema: typeof ZEABUR_CONNECTOR_REGISTRY_READBACK_SCHEMA;
  capturedAt: string;
  source: "zeabur_service_exec" | "aos_remote_readback" | "unknown";
  target: {
    projectId: string;
    serviceId: string;
    serviceName: string;
    environmentId: string;
  };
  appServer: {
    servicePresent: boolean;
    runtimeStatus: "running" | "blocked" | "unknown";
    codexLogin: "logged_in" | "not_logged_in" | "unknown";
  };
  pluginRegistry: {
    installed: ZeaburPluginRegistryEntry[];
    available: ZeaburPluginRegistryEntry[];
  };
  mcpRegistry: {
    configuredCount: number;
    verified: boolean;
    names: string[];
  };
  connectorAuth: Record<string, ConnectorAuthStatus>;
  exactBlocker: string | null;
  secretMaterialIncluded: false;
};

export type ConnectorExecutionPlacement = {
  schema: "aos_connector_execution_placement.v1";
  connector: ConnectorId;
  owner: ConnectorExecutionOwner;
  status: "ready" | "blocked" | "explicit_fallback";
  zeaburPluginInstalled: boolean;
  zeaburConnectorAuth: ConnectorAuthStatus;
  zeaburMcpConfigured: boolean;
  macWorkerDefaultSurface: "chrome_plugin_profile2";
  fallbackPolicy: "explicit_only";
  exactBlocker: string | null;
  nextAction: string;
  externalActionExecuted: false;
  secretMaterialIncluded: false;
};

export function missingZeaburConnectorRegistryReadback(): ZeaburConnectorRegistryReadback {
  return {
    schema: ZEABUR_CONNECTOR_REGISTRY_READBACK_SCHEMA,
    capturedAt: new Date().toISOString(),
    source: "unknown",
    target: { projectId: "", serviceId: "", serviceName: "codex-app-server", environmentId: "" },
    appServer: { servicePresent: false, runtimeStatus: "unknown", codexLogin: "unknown" },
    pluginRegistry: { installed: [], available: [] },
    mcpRegistry: { configuredCount: 0, verified: false, names: [] },
    connectorAuth: {},
    exactBlocker: "zeabur_codex_app_server_registry_readback_missing",
    secretMaterialIncluded: false
  };
}

export function readZeaburConnectorRegistryReadback(
  env: NodeJS.ProcessEnv = process.env
): ZeaburConnectorRegistryReadback {
  const path = env.AUTOMATION_OS_CODEX_APP_SERVER_REGISTRY_READBACK_PATH?.trim();
  if (!path || !existsSync(path)) return missingZeaburConnectorRegistryReadback();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return sanitizeZeaburConnectorRegistryReadback(parsed);
  } catch {
    return { ...missingZeaburConnectorRegistryReadback(), exactBlocker: "zeabur_codex_app_server_registry_readback_invalid" };
  }
}

export function buildConnectorExecutionPlacement(input: {
  connector: ConnectorId;
  zeabur: ZeaburConnectorRegistryReadback;
  companyConnectionVerified: boolean;
  explicitMacConnectorFallback?: boolean;
}): ConnectorExecutionPlacement {
  const connector = input.connector.trim().toLowerCase();
  const plugin = input.zeabur.pluginRegistry.installed.find((item) => item.name.toLowerCase() === connector);
  const authStatus = input.zeabur.connectorAuth[connector] ?? plugin?.authStatus ?? "unknown";
  const appServerReady = input.zeabur.appServer.servicePresent
    && input.zeabur.appServer.runtimeStatus === "running"
    && input.zeabur.appServer.codexLogin === "logged_in";
  const pluginReady = Boolean(plugin?.installed);
  const companyReady = input.companyConnectionVerified;
  const registryHardBlocker = [
    "zeabur_codex_app_server_registry_readback_missing",
    "zeabur_codex_app_server_registry_readback_invalid",
    "zeabur_service_exec_readback_failed",
    "zeabur_cli_authentication_unavailable",
    "zeabur_codex_app_server_service_missing",
    "zeabur_codex_app_server_runtime_not_ready",
    "zeabur_codex_app_server_login_not_verified"
  ].includes(input.zeabur.exactBlocker ?? "")
    ? input.zeabur.exactBlocker
    : null;
  const ready = registryHardBlocker === null && appServerReady && pluginReady && authStatus === "verified" && companyReady;
  const exactBlocker = registryHardBlocker
    ?? (ready
      ? null
    : !input.zeabur.appServer.servicePresent
      ? "zeabur_codex_app_server_service_missing"
      : input.zeabur.appServer.runtimeStatus !== "running"
        ? "zeabur_codex_app_server_runtime_not_ready"
        : input.zeabur.appServer.codexLogin !== "logged_in"
          ? "zeabur_codex_app_server_login_not_verified"
          : !pluginReady
            ? "zeabur_plugin_not_installed"
            : authStatus !== "verified"
              ? "zeabur_connector_auth_not_verified"
              : !companyReady
                ? "company_connection_not_verified"
                : "zeabur_connector_execution_not_ready");
  if (ready) {
    return {
      schema: "aos_connector_execution_placement.v1",
      connector,
      owner: "zeabur_codex_app_server",
      status: "ready",
      zeaburPluginInstalled: true,
      zeaburConnectorAuth: authStatus,
      zeaburMcpConfigured: input.zeabur.mcpRegistry.configuredCount > 0,
      macWorkerDefaultSurface: "chrome_plugin_profile2",
      fallbackPolicy: "explicit_only",
      exactBlocker: null,
      nextAction: "Zeabur Codex App ServerのPluginを同一Runで呼び、provider receipt・source sync・reconciliationを確認する",
      externalActionExecuted: false,
      secretMaterialIncluded: false
    };
  }
  if (input.explicitMacConnectorFallback === true) {
    return {
      schema: "aos_connector_execution_placement.v1",
      connector,
      owner: "mac_worker_explicit_connector_fallback",
      status: "explicit_fallback",
      zeaburPluginInstalled: pluginReady,
      zeaburConnectorAuth: authStatus,
      zeaburMcpConfigured: input.zeabur.mcpRegistry.configuredCount > 0,
      macWorkerDefaultSurface: "chrome_plugin_profile2",
      fallbackPolicy: "explicit_only",
      exactBlocker,
      nextAction: "明示されたMac connector fallbackのscope・Profile 2・same-run receiptを確認してから実行する",
      externalActionExecuted: false,
      secretMaterialIncluded: false
    };
  }
  return {
    schema: "aos_connector_execution_placement.v1",
    connector,
    owner: "none",
    status: "blocked",
    zeaburPluginInstalled: pluginReady,
    zeaburConnectorAuth: authStatus,
    zeaburMcpConfigured: input.zeabur.mcpRegistry.configuredCount > 0,
    macWorkerDefaultSurface: "chrome_plugin_profile2",
    fallbackPolicy: "explicit_only",
    exactBlocker,
    nextAction: "Zeabur側のPlugin認証・会社scope・runtime readbackを揃える。Mac connectorへは暗黙切替しない",
    externalActionExecuted: false,
    secretMaterialIncluded: false
  };
}

/**
 * An installed Plugin may still need provider OAuth.  Allow the official
 * App Server `plugin/install` handshake to return its authorization URL, but
 * only for that exact installed Plugin while the sole blocker is the missing
 * connector auth.  This does not make the connector executable or bypass a
 * runtime/login/registry blocker.
 */
export function canBootstrapInstalledPluginAuth(input: {
  registry: ZeaburConnectorRegistryReadback;
  pluginName: string;
}): boolean {
  if (input.registry.exactBlocker !== "zeabur_connector_auth_not_verified") return false;
  const pluginName = input.pluginName.trim().toLowerCase();
  if (!pluginName) return false;
  return input.registry.pluginRegistry.installed.some((entry) =>
    entry.installed && entry.name.trim().toLowerCase() === pluginName
  );
}

export function sanitizeZeaburConnectorRegistryReadback(value: Record<string, unknown>): ZeaburConnectorRegistryReadback {
  const target = objectValue(value.target);
  const appServer = objectValue(value.appServer);
  const pluginRegistry = objectValue(value.pluginRegistry);
  const mcpRegistry = objectValue(value.mcpRegistry);
  const connectorAuth = objectValue(value.connectorAuth);
  return {
    schema: ZEABUR_CONNECTOR_REGISTRY_READBACK_SCHEMA,
    capturedAt: stringValue(value.capturedAt) ?? new Date().toISOString(),
    source: value.source === "zeabur_service_exec" || value.source === "aos_remote_readback" ? value.source : "unknown",
    target: {
      projectId: stringValue(target.projectId) ?? "",
      serviceId: stringValue(target.serviceId) ?? "",
      serviceName: stringValue(target.serviceName) ?? "codex-app-server",
      environmentId: stringValue(target.environmentId) ?? ""
    },
    appServer: {
      servicePresent: targetBool(appServer.servicePresent),
      runtimeStatus: appServer.runtimeStatus === "running" || appServer.runtimeStatus === "blocked" ? appServer.runtimeStatus : "unknown",
      codexLogin: appServer.codexLogin === "logged_in" || appServer.codexLogin === "not_logged_in" ? appServer.codexLogin : "unknown"
    },
    pluginRegistry: {
      installed: pluginEntries(pluginRegistry.installed),
      available: pluginEntries(pluginRegistry.available)
    },
    mcpRegistry: {
      configuredCount: Math.max(0, Number(mcpRegistry.configuredCount ?? 0)),
      verified: targetBool(mcpRegistry.verified),
      names: stringArray(mcpRegistry.names)
    },
    connectorAuth: Object.fromEntries(Object.entries(connectorAuth).map(([key, status]) => [key, authStatus(status)])),
    exactBlocker: stringValue(value.exactBlocker) ?? null,
    secretMaterialIncluded: false
  };
}

function pluginEntries(value: unknown): ZeaburPluginRegistryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = objectValue(item);
    const name = stringValue(record.name) ?? stringValue(record.pluginName);
    if (!name) return [];
    const id = stringValue(record.id) ?? stringValue(record.pluginId) ?? name;
    const marketplaceName = stringValue(record.marketplaceName) ?? (id.includes("@") ? id.slice(id.lastIndexOf("@") + 1) : undefined);
    return [{
      id,
      name,
      installed: targetBool(record.installed),
      authStatus: authStatus(record.authStatus),
      ...(marketplaceName ? { marketplaceName } : {}),
      ...(record.authPolicy === "ON_INSTALL" || record.authPolicy === "ON_USE" ? { authPolicy: record.authPolicy } : {})
    }];
  });
}

function authStatus(value: unknown): ConnectorAuthStatus {
  return value === "verified" || value === "unverified" || value === "missing" ? value : "unknown";
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()).slice(0, 100) : [];
}

function targetBool(value: unknown): boolean {
  return value === true || value === 1 || value === "true";
}

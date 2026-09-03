import type { CodexCapabilitiesSummary } from "../codex/capabilities.js";
import { buildToolPreferenceSnapshot, type CompanyConnectionRefLike } from "../codex/capabilityRouter.js";
import type { ZeaburConnectorRegistryReadback } from "../codex/zeaburConnectorRouting.js";

export type GmailReadOnlyCanaryReadback = {
  schema: "aos_gmail_read_only_canary.v1";
  status: "ready_for_provider_call" | "blocked";
  companyId: string;
  connector: "gmail";
  transport: "codex_app_server_plugin" | "codex_app_server_mcp";
  selectedTool: { id: string; label: string; kind: string; status: string } | null;
  exactBlocker: string | null;
  nextAction: string;
  externalActionExecuted: false;
  dataRead: false;
  dataPersisted: false;
  secretMaterialIncluded: false;
  providerReceipt: null;
  reconciliation: { required: true; status: "not_started" };
};

/**
 * Build the Gmail canary admission readback without calling Gmail or copying
 * provider data. The eventual provider call belongs to the Codex App
 * Server/MCP connector and must publish a same-run receipt before any AOS
 * business completion claim is possible.
 */
export function buildGmailReadOnlyCanaryReadback(input: {
  companyId: string;
  capabilities: CodexCapabilitiesSummary;
  companyConnectionRefs: readonly CompanyConnectionRefLike[];
  zeaburConnectorRegistry?: ZeaburConnectorRegistryReadback;
}): GmailReadOnlyCanaryReadback {
  const companyId = input.companyId.trim();
  const capabilities = capabilitiesFromCompanyRegistry(input.capabilities, input.zeaburConnectorRegistry);
  const toolPreference = buildToolPreferenceSnapshot({
    command: "Gmail read-only canary",
    capabilities,
    companyIds: companyId ? [companyId] : [],
    companyConnectionRefs: input.companyConnectionRefs,
    zeaburConnectorRegistry: input.zeaburConnectorRegistry
  });
  const selected = toolPreference.selected;
  const gmailRef = input.companyConnectionRefs.find((ref) => String(ref.platform ?? "").toLowerCase() === "gmail" || String(ref.platform ?? "").toLowerCase() === "mail");
  const blockers: string[] = [];
  if (!companyId) blockers.push("company_id_required");
  if (!gmailRef) blockers.push("gmail_company_connection_ref_missing");
  else if (!isVerifiedConnection(gmailRef)) blockers.push("gmail_company_connection_unverified");
  if (!selected) blockers.push("gmail_tool_candidate_missing");
  if (selected && selected.kind !== "plugin" && selected.kind !== "mcp") blockers.push("gmail_plugin_or_mcp_candidate_missing");
  if (selected?.kind !== "plugin" && capabilities.capabilities.mcp.state.verified !== true) blockers.push("gmail_mcp_not_verified");
  if (capabilities.capabilities.appServer.state.verified !== true) blockers.push("codex_app_server_not_verified");
  const exactBlocker = blockers[0] ?? null;
  const transport = selected?.kind === "plugin" ? "codex_app_server_plugin" : "codex_app_server_mcp";
  return {
    schema: "aos_gmail_read_only_canary.v1",
    status: exactBlocker ? "blocked" : "ready_for_provider_call",
    companyId,
    connector: "gmail",
    transport,
    selectedTool: selected ? { id: selected.id, label: selected.label, kind: selected.kind, status: selected.status } : null,
    exactBlocker,
    nextAction: exactBlocker
      ? "会社scopeのGmail接続参照、Codex App Server、MCPのfresh readbackを揃えてから同じcanaryを再確認する"
      : `Codex App Server/${selected?.kind === "plugin" ? "Plugin" : "MCP"}のGmail read-only toolを同一Runで1回だけ呼び、provider receiptとsource readbackを照合する`,
    externalActionExecuted: false,
    dataRead: false,
    dataPersisted: false,
    secretMaterialIncluded: false,
    providerReceipt: null,
    reconciliation: { required: true, status: "not_started" }
  };
}

function capabilitiesFromCompanyRegistry(
  capabilities: CodexCapabilitiesSummary,
  registry?: ZeaburConnectorRegistryReadback
): CodexCapabilitiesSummary {
  if (!registry || registry.exactBlocker !== null) return capabilities;
  const appServerReady = registry.appServer.servicePresent
    && registry.appServer.runtimeStatus === "running"
    && registry.appServer.codexLogin === "logged_in";
  const gmailInstalled = registry.pluginRegistry.installed.some((plugin) =>
    plugin.installed && plugin.name.trim().toLowerCase() === "gmail" && plugin.authStatus === "verified"
  );
  if (!appServerReady && !gmailInstalled) return capabilities;
  const next = {
    ...capabilities,
    capabilities: {
      ...capabilities.capabilities,
      appServer: appServerReady
        ? {
          ...capabilities.capabilities.appServer,
          status: "available_with_codex_runtime" as const,
          state: { configured: true, enabled: true, verified: true, connected: false }
        }
        : capabilities.capabilities.appServer,
      plugins: gmailInstalled && !capabilities.capabilities.plugins.some((plugin) => plugin.name.trim().toLowerCase() === "gmail")
        ? [
          ...capabilities.capabilities.plugins,
          {
            id: "zeabur:plugin:gmail",
            name: "Gmail",
            path: "codex-app-server://plugin/gmail",
            status: "available_with_codex_runtime" as const,
            kind: "plugin",
            state: { configured: true, enabled: true, verified: true, connected: false },
            catalogSource: "official" as const
          }
        ]
        : capabilities.capabilities.plugins
    }
  };
  return next;
}

function isVerifiedConnection(ref: CompanyConnectionRefLike): boolean {
  const verification = ref.verificationStatus ?? ref.verification_status;
  const oauth = ref.oauthState ?? ref.oauth_state;
  return ref.status === "verified" && verification === "verified" && oauth === "connected";
}

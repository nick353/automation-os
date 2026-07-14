import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { basename, join, relative } from "node:path";
import { getBrowserHealth } from "../browser/health.js";
import type { CodexAppServerProbeResult } from "./appServerProbe.js";
import type { CapabilityAxisState, McpProbeResult } from "./capabilityProbe.js";

type CapabilityItem = {
  id: string;
  name: string;
  path: string;
  status: "available" | "available_with_codex_runtime" | "requires_bridge" | "read_only_indexed" | "missing";
  kind: string;
  state: CapabilityAxisState;
  role?: "primary" | "helper";
  hiddenFromSuggestions?: boolean;
};

export type CodexCapabilitiesSummary = {
  generatedAt: string;
  roots: Record<string, { path: string; exists: boolean }>;
  summary: {
    skills: number;
    agentSkills: number;
    plugins: number;
    automations: number;
    mcp: number;
  };
  capabilities: {
    browser: CapabilityItem;
    chrome: CapabilityItem;
    automationOsApi: CapabilityItem;
    appServer: CapabilityItem;
    mcp: CapabilityItem;
    cli: CapabilityItem;
    skills: CapabilityItem[];
    plugins: CapabilityItem[];
    automations: CapabilityItem[];
  };
  notes: string[];
};

export function getCodexCapabilities(options: {
  mcpProbe?: McpProbeResult | null;
  appServerProbe?: CodexAppServerProbeResult | null;
} = {}): CodexCapabilitiesSummary {
  const home = process.env.AUTOMATION_OS_CAPABILITIES_HOME ?? homedir();
  const codexRoot = process.env.AUTOMATION_OS_CODEX_ROOT ?? join(home, ".codex");
  const agentsRoot = process.env.AUTOMATION_OS_AGENTS_ROOT ?? join(home, ".agents");
  const skillRoots = envPaths("AUTOMATION_OS_CODEX_SKILL_ROOTS", [join(codexRoot, "skills")]);
  const agentSkillRoots = envPaths("AUTOMATION_OS_AGENT_SKILL_ROOTS", [join(agentsRoot, "skills")]);
  const pluginRoots = envPaths("AUTOMATION_OS_CODEX_PLUGIN_ROOTS", [join(codexRoot, "plugins", "cache")]);
  const roots = {
    codexSkills: skillRoots.join(":"),
    agentSkills: agentSkillRoots.join(":"),
    pluginsCache: pluginRoots.join(":"),
    automations: process.env.AUTOMATION_OS_CODEX_AUTOMATIONS_ROOT ?? join(codexRoot, "automations")
  };
  const codexSkills = skillRoots.flatMap((root) => scanSkillDir(root, "codex_skill"));
  const agentSkills = agentSkillRoots.flatMap((root) => scanSkillDir(root, "agent_skill"));
  const skills = [...codexSkills, ...agentSkills];
  const plugins = pluginRoots.flatMap(scanPlugins);
  const automations = scanAutomations(roots.automations);
  const browserHealth = getBrowserHealth();
  const mcpProbe = options.mcpProbe ?? null;
  const appServerProbe = options.appServerProbe ?? null;
  const codexRuntimeAvailable = commandExists("codex");
  const appServerEnabled = process.env.AUTOMATION_OS_CODEX_APP_SERVER_PROBE_ENABLED === "1";
  const appServerConfigured = codexRuntimeAvailable;
  const mcpState = mcpProbe?.state ?? {
    configured: codexRuntimeAvailable,
    enabled: codexRuntimeAvailable,
    verified: false,
    connected: false
  };
  const appServerState = {
    configured: appServerConfigured,
    enabled: appServerEnabled,
    verified: appServerProbe?.ok ?? false,
    connected: false
  };
  const mcpCount = mcpProbe?.entries.length ?? 0;

  return {
    generatedAt: new Date().toISOString(),
    roots: Object.fromEntries(Object.entries(roots).map(([key, path]) => [key, { path, exists: path.split(":").some((entry) => existsSync(entry)) }])),
    summary: {
      skills: codexSkills.length,
      agentSkills: agentSkills.length,
      plugins: plugins.length,
      automations: automations.length,
      mcp: mcpCount
    },
    capabilities: {
      browser: {
        id: "browser-in-app",
        name: "Browser / In-App Browser",
        path: "plugin://Browser",
        status: "requires_bridge",
        kind: "browser_bridge",
        state: browserSurfaceState(browserHealth)
      },
      chrome: {
        id: "chrome-extension",
        name: "Chrome extension lane",
        path: "plugin://Chrome",
        status: "requires_bridge",
        kind: "browser_bridge",
        state: chromeSurfaceState(browserHealth)
      },
      automationOsApi: {
        id: "automation-os-api",
        name: "Automation OS local API server",
        path: "http://127.0.0.1",
        status: "available",
        kind: "automation_os_api",
        state: connectedState(true)
      },
      appServer: {
        id: "codex-app-server",
        name: "Codex App Server",
        path: "codex-app-server://stdio",
        status: appServerConfigured ? "available_with_codex_runtime" : "missing",
        kind: "codex_app_server",
        state: appServerState
      },
      mcp: {
        id: "mcp-tools",
        name: "MCP tools exposed by Codex runtime",
        path: "codex-runtime://mcp",
        status: mcpState.connected
          ? "available"
          : codexRuntimeAvailable || mcpState.enabled
            ? "available_with_codex_runtime"
            : "missing",
        kind: "mcp",
        state: mcpState
      },
      cli: {
        id: "codex-cli",
        name: "Codex CLI",
        path: "command://codex",
        status: commandExists("codex") ? "available_with_codex_runtime" : "missing",
        kind: "cli",
        state: commandState("codex")
      },
      skills,
      plugins,
      automations
    },
    notes: [
      "This endpoint is a read-only local inventory and does not execute plugins, skills, automations, or MCP calls.",
      `Browser bridge readback: localApp.canReportHealth=${browserHealth.localApp.canReportHealth}, localApp.canExecuteBrowserPlugin=${browserHealth.localApp.canExecuteBrowserPlugin}.`,
      `Browser bridge directCallableFromLocalApp=${browserHealth.codexBrowserBridge.directCallableFromLocalApp}.`,
      appServerProbe
        ? `Codex App Server probe is read-only and bounded; status=${appServerProbe.status}, exactBlocker=${appServerProbe.exactBlocker ?? "none"}, protocol=${appServerProbe.protocol}.`
        : "Codex App Server probe not run yet; capability state stays inventory-only until POST /api/codex/app-server/probe refreshes it.",
      mcpProbe
        ? `MCP probe is read-only, bounded, and TTL-cached; parsed entries=${mcpProbe.entries.length}, parsedFrom=${mcpProbe.parsedFrom}.`
        : codexRuntimeAvailable
          ? "MCP probe not run yet; Codex runtime is present but capability state stays inventory-only until POST /api/codex/capabilities/probe refreshes it."
          : "MCP probe not run yet and Codex runtime command is missing; capability state is inventory-only."
    ]
  };
}

function scanSkillDir(root: string, kind: string): CapabilityItem[] {
  if (!existsSync(root)) return [];
  return safeReadDir(root)
    .map((entry) => join(root, entry))
    .filter((path) => safeIsDirectory(path))
    .map((path) => ({
      id: `skill:${basename(path)}`,
      name: readSkillName(path) ?? basename(path),
      path: relativeToHome(path),
      status: "read_only_indexed" as const,
      kind,
      state: localInventoryState()
    }))
    .sort(byName);
}

function scanPlugins(root: string): CapabilityItem[] {
  if (!existsSync(root)) return [];
  const children = safeReadDir(root).map((entry) => join(root, entry)).filter((path) => safeIsDirectory(path));
  const pluginRoots = children.flatMap((child) => {
    if (safeIsFile(join(child, ".codex-plugin", "plugin.json"))) return [child];
    return safeReadDir(child).map((entry) => join(child, entry)).filter((path) => safeIsDirectory(path));
  });
  return pluginRoots
    .map((path) => ({
      id: `plugin:${basename(path)}`,
      name: pluginDisplayName(path),
      path: relativeToHome(path),
      status: "available_with_codex_runtime" as const,
      kind: "plugin",
      state: localInventoryState()
    }))
    .sort(byName);
}

function scanAutomations(root: string): CapabilityItem[] {
  if (!existsSync(root)) return [];
  return safeReadDir(root)
    .flatMap((entry) => {
      const path = join(root, entry);
      if (safeIsFile(path) && entry.endsWith(".toml")) return [path];
      const nested = join(path, "automation.toml");
      return safeIsFile(nested) ? [nested] : [];
    })
    .map((path) => {
      const name = basename(path) === "automation.toml" ? basename(join(path, "..")) : basename(path, ".toml");
      const helper = isHelperAutomation(name);
      return {
        id: `automation:${name}`,
        name,
        path: relativeToHome(path),
        status: "available_with_codex_runtime" as const,
        kind: helper ? "automation_helper" : "automation",
        state: localInventoryState(),
        role: helper ? "helper" as const : "primary" as const,
        hiddenFromSuggestions: helper
      };
    })
    .sort(byName);
}

function readSkillName(path: string): string | undefined {
  const skillPath = join(path, "SKILL.md");
  if (!safeIsFile(skillPath)) return undefined;
  const head = readFileSync(skillPath, "utf8").slice(0, 1200);
  return head.match(/^name:\s*(.+)$/m)?.[1]?.trim();
}

function pluginDisplayName(path: string): string {
  const pluginJson = join(path, ".codex-plugin", "plugin.json");
  if (safeIsFile(pluginJson)) {
    try {
      const parsed = JSON.parse(readFileSync(pluginJson, "utf8")) as { name?: unknown; displayName?: unknown };
      const name = parsed.displayName ?? parsed.name;
      if (typeof name === "string" && name.trim()) return name.trim();
    } catch {
      return basename(path);
    }
  }
  return basename(path);
}

function safeReadDir(path: string): string[] {
  try {
    return readdirSync(path).filter((entry) => !entry.startsWith(".")).slice(0, 400);
  } catch {
    return [];
  }
}

function envPaths(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.split(":").map((entry) => entry.trim()).filter(Boolean);
}

function safeIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function safeIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function relativeToHome(path: string): string {
  const home = process.env.AUTOMATION_OS_CAPABILITIES_HOME ?? homedir();
  const rel = relative(home, path);
  return rel.startsWith("..") ? path : `~/${rel}`;
}

function byName(a: CapabilityItem, b: CapabilityItem): number {
  return a.name.localeCompare(b.name);
}

function isHelperAutomation(name: string): boolean {
  return [
    "automation-live-supervisor",
    "automation-live-supervisor-2",
    "automation-child-launcher-bridge"
  ].includes(name);
}

function localInventoryState(): CapabilityAxisState {
  return {
    configured: true,
    enabled: true,
    verified: true,
    connected: false
  };
}

function browserSurfaceState(browserHealth: ReturnType<typeof getBrowserHealth>): CapabilityAxisState {
  return {
    configured: true,
    enabled: browserHealth.localApp.canReportHealth,
    verified: browserHealth.codexBrowserBridge.required,
    connected: browserHealth.codexBrowserBridge.directCallableFromLocalApp
  };
}

function chromeSurfaceState(browserHealth: ReturnType<typeof getBrowserHealth>): CapabilityAxisState {
  return {
    configured: true,
    enabled: browserHealth.chromeExtension.status === "ready",
    verified: browserHealth.chromeExtension.status === "ready",
    connected: browserHealth.chromeExtension.status === "ready"
  };
}

function connectedState(connected: boolean): CapabilityAxisState {
  return {
    configured: true,
    enabled: connected,
    verified: connected,
    connected
  };
}

function commandState(command: string): CapabilityAxisState {
  const connected = commandExists(command);
  return connectedState(connected);
}

function commandExists(command: string): boolean {
  const result = spawnSync("sh", ["-lc", `command -v ${shellEscape(command)}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  return result.status === 0 && result.stdout.trim().length > 0;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

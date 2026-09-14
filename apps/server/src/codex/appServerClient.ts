import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { createHash } from "node:crypto";
import WebSocket from "ws";
import { redactSensitiveText } from "../obsidian/redaction.js";
import { resolveBoundedWorkspacePath } from "../security/processEnvironment.js";
import {
  remoteWorkspaceCwd,
  resolveCodexAppServerConnection,
  type CodexAppServerConnectionOptions,
  type ResolvedCodexAppServerConnection
} from "./appServerConnection.js";

type WritableLike = {
  write(chunk: string): boolean;
  on(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
};

type ReadableLike = {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  removeListener(event: "data", listener: (chunk: Buffer | string) => void): unknown;
};

export type AppServerChildLike = {
  stdin: WritableLike;
  stdout: ReadableLike;
  stderr: ReadableLike;
  on(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
};

export type AppServerProcessFactory = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio
) => AppServerChildLike;

export type AppServerWebSocketLike = {
  addEventListener(event: "open" | "message" | "error" | "close", listener: (event: { data?: unknown; code?: number; reason?: string }) => void, options?: { once?: boolean }): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type AppServerWebSocketFactory = (
  url: string,
  init: { headers: Record<string, string> }
) => AppServerWebSocketLike;

export type CodexAppServerEvent = {
  method: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  toolArguments?: Record<string, unknown>;
  itemType?: string;
  toolName?: string;
  serverName?: string;
  delta?: string;
  status?: string;
  capturedAt: string;
};

export type CodexAppServerTurnResult = {
  threadId: string;
  turnId: string;
  status: "completed" | "interrupted" | "failed" | "blocked";
  text: string;
  structured: Record<string, unknown> | null;
  /** Hash of the declared provider account before public-output redaction.
   * Not provider proof by itself: callers must verify the corresponding tool event. */
  providerAccountHash?: string;
  providerAccountHashSource?: "gmail_profile_tool" | "declared_output";
  /** Actual, bounded search metadata. Pagination token is transient only. */
  gmailSummaryPage?: { messages: Array<{ id: string; subject: string; snippet: string }>; nextPageToken: string | null; unfiltered: boolean };
  /** Actual structured result from one Gmail metadata message read. */
  gmailSourceMessage?: { id: string; thread_id: string; payload: { headers: Array<{ name: string; value: string }> }; history_id?: string; label_ids?: string[] };
  events: CodexAppServerEvent[];
  exactBlocker?: string;
};

export type CodexAppServerAccountReadback = {
  accountPresent: boolean;
  accountType: string | null;
  planType: string | null;
  requiresOpenaiAuth: boolean;
};

export type CodexAppServerDeviceLogin = {
  loginId: string;
  verificationUrl: string;
  userCode: string;
};

export type CodexAppServerAuthEventReadback = {
  loginCompletion: {
    loginId: string | null;
    success: boolean;
    error: string | null;
    capturedAt: string;
  } | null;
  accountUpdated: {
    authMode: string | null;
    planType: string | null;
    capturedAt: string;
  } | null;
};

export type CodexAppServerPluginInstallResult = {
  pluginName: string;
  marketplaceName: string | null;
  authPolicy: "ON_INSTALL" | "ON_USE" | null;
  appsNeedingAuth: Array<{
    id: string;
    name: string;
    category: string | null;
    description: string | null;
    installUrl: string | null;
  }>;
};

export type CodexAppServerInstalledAppReadback = {
  id: string;
  runtimeName: string | null;
  enabled: boolean;
  callable: boolean;
};

export type CodexAppServerAppReadback = {
  id: string;
  name: string | null;
  isAccessible: boolean;
  isEnabled: boolean;
  accessStateAvailable: boolean;
  installUrl: string | null;
};

export type CodexAppServerPluginAppsReadback = {
  pluginName: string;
  marketplaceName: string | null;
  apps: Array<{ id: string; name: string | null }>;
};

type PendingRequest = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type PendingCompletion = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type JsonRpcMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
};

const defaultTimeoutMs = 45_000;
const maxTimeoutMs = 120_000;
const maxTurnTimeoutMs = 300_000;
// Planner turns can contain a single JSONL notification with a large
// connector/tool payload (notably Gmail's structured envelope). The parsed
// event/text surfaces below remain bounded, so allow a larger protocol frame
// while retaining a hard memory ceiling.
const maxLineBytes = 64 * 1024 * 1024;
const maxEventsPerTurn = 160;

/**
 * A deliberately small JSONL client for the local Codex App Server.
 *
 * The client is worker-owned: it never exposes the process, credential
 * environment, or raw protocol messages to the web/API surface.
 */
export class CodexAppServerClient {
  private child: AppServerChildLike | null = null;
  private connection: ResolvedCodexAppServerConnection | null = null;
  private initialized = false;
  private connecting: Promise<void> | null = null;
  private nextRequestId = 1;
  private lineBuffer = "";
  private closed = false;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly completions = new Map<string, PendingCompletion>();
  private readonly recentCompletions = new Map<string, Record<string, unknown>>();
  private readonly turnEvents = new Map<string, CodexAppServerEvent[]>();
  private readonly turnText = new Map<string, string>();
  private readonly turnProviderAccountHashes = new Map<string, string>();
  private readonly turnProviderAccountToolProof = new Set<string>();
  private readonly turnGmailSummaryPages = new Map<string, NonNullable<CodexAppServerTurnResult["gmailSummaryPage"]>>();
  private readonly turnGmailSourceMessages = new Map<string, NonNullable<CodexAppServerTurnResult["gmailSourceMessage"]>>();
  private readonly turnToThread = new Map<string, string>();
  private readonly turnListeners = new Map<string, (event: CodexAppServerEvent) => void>();
  private readonly pendingTurnListeners = new Map<string, (event: CodexAppServerEvent) => void>();
  private authLoginCompletion: CodexAppServerAuthEventReadback["loginCompletion"] = null;
  private authAccountUpdated: CodexAppServerAuthEventReadback["accountUpdated"] = null;

  constructor(private readonly options: {
    command?: string;
    cwd?: string;
    workspaceRoot?: string;
    timeoutMs?: number;
    turnTimeoutMs?: number;
    processFactory?: AppServerProcessFactory;
    webSocketFactory?: AppServerWebSocketFactory;
    remoteUrl?: string;
    remoteToken?: string;
    remoteCwd?: string;
    onEvent?: (event: CodexAppServerEvent) => void;
  } = {}) {}

  async start(): Promise<void> {
    if (this.initialized) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.startInternal().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async startOrResumeThread(threadId?: string, options: { ephemeral?: boolean } = {}): Promise<string> {
    await this.start();
    const method = threadId?.trim() ? "thread/resume" : "thread/start";
    const params: Record<string, unknown> = threadId?.trim()
      ? {
          threadId: threadId.trim(),
          approvalPolicy: "never",
          sandbox: "read-only",
          serviceName: "automation_os_chat"
        }
      : {
          approvalPolicy: "never",
          sandbox: "read-only",
          serviceName: "automation_os_chat",
          ephemeral: options.ephemeral ?? false
        };
    this.applyCwd(params);
    const response = await this.request(method, params);
    const returnedThread = response.result && typeof response.result === "object"
      ? (response.result as Record<string, unknown>).thread
      : undefined;
    const returnedId = returnedThread && typeof returnedThread === "object"
      ? (returnedThread as Record<string, unknown>).id
      : undefined;
    if (typeof returnedId !== "string" || !returnedId.trim()) {
      throw new Error("codex_app_server_thread_id_missing");
    }
    return returnedId.trim();
  }

  async readAccount(): Promise<CodexAppServerAccountReadback> {
    await this.start();
    const response = await this.request("account/read", { refreshToken: false });
    const result = response.result && typeof response.result === "object"
      ? (response.result as Record<string, unknown>)
      : {};
    const account = result.account && typeof result.account === "object"
      ? (result.account as Record<string, unknown>)
      : null;
    return {
      accountPresent: Boolean(account),
      accountType: typeof account?.type === "string" ? account.type : null,
      planType: typeof account?.planType === "string" ? account.planType : null,
      requiresOpenaiAuth: result.requiresOpenaiAuth === true
    };
  }

  async startDeviceCodeLogin(): Promise<CodexAppServerDeviceLogin> {
    await this.start();
    this.authLoginCompletion = null;
    this.authAccountUpdated = null;
    const response = await this.request("account/login/start", { type: "chatgptDeviceCode" });
    const result = response.result && typeof response.result === "object"
      ? (response.result as Record<string, unknown>)
      : {};
    const loginId = stringValue(result.loginId);
    const verificationUrl = safeAuthUrl(result.verificationUrl);
    const userCode = boundedDeviceCode(result.userCode);
    if (!loginId || !verificationUrl || !userCode) throw new Error("codex_device_auth_start_response_invalid");
    return { loginId, verificationUrl, userCode };
  }

  getAuthEventReadback(): CodexAppServerAuthEventReadback {
    return {
      loginCompletion: this.authLoginCompletion ? { ...this.authLoginCompletion } : null,
      accountUpdated: this.authAccountUpdated ? { ...this.authAccountUpdated } : null
    };
  }

  async readInstalledApps(input: { forceRefresh?: boolean } = {}): Promise<CodexAppServerInstalledAppReadback[]> {
    await this.start();
    const response = await this.request("app/installed", { forceRefresh: input.forceRefresh === true });
    const result = response.result && typeof response.result === "object"
      ? (response.result as Record<string, unknown>)
      : {};
    return Array.isArray(result.apps)
      ? result.apps.flatMap((value) => {
          if (!value || typeof value !== "object") return [];
          const app = value as Record<string, unknown>;
          const id = stringValue(app.id);
          if (!id) return [];
          return [{
            id,
            runtimeName: stringValue(app.runtimeName) ?? null,
            enabled: app.enabled === true,
            callable: app.callable === true
          }];
        }).slice(0, 500)
      : [];
  }

  async readApp(input: { appId: string; includeTools?: boolean }): Promise<CodexAppServerAppReadback | null> {
    const appId = boundedPluginName(input.appId, "codex_app_server_app_id_required");
    await this.start();
    const response = await this.request("app/read", {
      appIds: [appId],
      includeTools: input.includeTools === true
    });
    const result = response.result && typeof response.result === "object"
      ? (response.result as Record<string, unknown>)
      : {};
    const app = Array.isArray(result.apps)
      ? result.apps.find((value) => value && typeof value === "object" && stringValue((value as Record<string, unknown>).id) === appId) as Record<string, unknown> | undefined
      : undefined;
    const id = stringValue(app?.id) ?? appId;
    if (!app) return null;
    const accessStateAvailable = Object.prototype.hasOwnProperty.call(app, "isAccessible")
      && Object.prototype.hasOwnProperty.call(app, "isEnabled");
    return {
      id,
      name: stringValue(app.name) ?? null,
      isAccessible: app.isAccessible === true,
      isEnabled: app.isEnabled === true,
      accessStateAvailable,
      installUrl: safeAuthUrl(app.installUrl)
    };
  }

  /** app/read is display metadata, not access state. Resolve exact IDs from
   * the paginated app/list and independently read effective runtime state. */
  async readPluginAccess(input: { pluginName: string; remoteMarketplaceName?: string }) {
    const plugin = await this.readPluginApps(input);
    const remaining = new Set(plugin.apps.map((app) => app.id));
    const apps: CodexAppServerAppReadback[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    let page = 0;
    let appListBlocker: string | null = null;
    while (remaining.size) {
      let response: Record<string, unknown>;
      try {
        response = await this.request("app/list", { cursor, limit: 100, forceRefetch: page === 0 });
      } catch (error) {
        // Older dedicated servers can reject catalog refresh while the
        // official effective-runtime read still works. Keep the diagnostic;
        // only a positive exact-ID enabled+callable result can verify access.
        const code = error instanceof Error ? error.message : "";
        if (!/^codex_app_server_request_rejected_code_-3260[13]$/.test(code)) throw error;
        appListBlocker = code;
        break;
      }
      const result = response.result as Record<string, unknown> | undefined;
      if (!Array.isArray(result?.data)) throw new Error("codex_app_server_app_list_invalid");
      for (const value of result.data) {
        if (!value || typeof value !== "object") continue;
        const app = value as Record<string, unknown>;
        const id = stringValue(app.id);
        if (!id || !remaining.has(id)) continue;
        remaining.delete(id);
        apps.push({ id, name: stringValue(app.name) ?? null,
          isAccessible: app.isAccessible === true, isEnabled: app.isEnabled === true,
          accessStateAvailable: typeof app.isAccessible === "boolean" && typeof app.isEnabled === "boolean",
          installUrl: safeAuthUrl(app.installUrl) });
      }
      cursor = stringValue(result.nextCursor) ?? null;
      if (!cursor || !remaining.size) break;
      if (cursors.has(cursor) || ++page >= 50) throw new Error("codex_app_server_app_list_pagination_invalid");
      cursors.add(cursor);
    }
    // Missing entries remain explicitly unknown; an empty result never proves
    // that a plugin has no authentication requirements (it may contain MCP).
    for (const app of plugin.apps) {
      if (!remaining.has(app.id)) continue;
      const metadata = await this.readApp({ appId: app.id });
      apps.push({ id: app.id, name: app.name, isAccessible: false, isEnabled: false,
        accessStateAvailable: false, installUrl: metadata?.installUrl ?? null });
    }
    const installed = await this.readInstalledApps({ forceRefresh: true });
    return {
      pluginName: plugin.pluginName,
      apps: apps.map((app) => {
        const callable = installed.some((entry) => entry.id === app.id && entry.enabled && entry.callable);
        const effectiveAccess = Boolean(appListBlocker && callable && !app.accessStateAvailable);
        return { ...app, callable,
          ...(effectiveAccess ? { isAccessible: true, isEnabled: true, accessStateAvailable: true } : {}),
          accessStateSource: effectiveAccess ? "app/installed" : app.accessStateAvailable ? "app/list" : "unverified"
        };
      }),
      appListBlocker,
      checkedAt: new Date().toISOString()
    };
  }

  async readPluginApps(input: {
    pluginName: string;
    remoteMarketplaceName?: string;
  }): Promise<CodexAppServerPluginAppsReadback> {
    const pluginName = boundedPluginName(input.pluginName, "codex_app_server_plugin_name_required");
    const marketplaceName = input.remoteMarketplaceName
      ? normalizeMarketplaceName(input.remoteMarketplaceName)
      : null;
    await this.start();
    const response = await this.request("plugin/read", {
      pluginName,
      ...(marketplaceName ? { remoteMarketplaceName: marketplaceName } : {})
    });
    const result = response.result && typeof response.result === "object"
      ? (response.result as Record<string, unknown>)
      : {};
    const plugin = result.plugin && typeof result.plugin === "object"
      ? result.plugin as Record<string, unknown>
      : result;
    const apps = Array.isArray(plugin.apps)
      ? plugin.apps.flatMap((value) => {
          if (!value || typeof value !== "object") return [];
          const app = value as Record<string, unknown>;
          const id = stringValue(app.id);
          if (!id) return [];
          return [{ id, name: stringValue(app.name) ?? null }];
        }).slice(0, 50)
      : [];
    return { pluginName, marketplaceName, apps };
  }

  /**
   * Install one exact Plugin through the remote Codex App Server registry.
   * The server response intentionally exposes only app metadata and a
   * provider auth URL; no connector token or credential material is returned.
   */
  async installPlugin(input: {
    pluginName: string;
    remoteMarketplaceName?: string;
    installAttemptId?: string;
  }): Promise<CodexAppServerPluginInstallResult> {
    const pluginName = boundedPluginName(input.pluginName, "codex_app_server_plugin_name_required");
    const marketplaceName = input.remoteMarketplaceName
      ? normalizeMarketplaceName(input.remoteMarketplaceName)
      : null;
    const installAttemptId = input.installAttemptId
      ? boundedPluginName(input.installAttemptId, "codex_app_server_install_attempt_id_invalid")
      : null;
    await this.start();
    let response: Record<string, unknown>;
    try {
      response = await this.request("plugin/install", {
        pluginName,
        ...(marketplaceName ? { remoteMarketplaceName: marketplaceName } : {}),
        ...(installAttemptId ? { installAttemptId } : {})
      });
    } catch (error) {
      // The current remote App Server exposes plugin/install as an
      // experimental RPC and may reject it with -32600 even though the
      // underlying Codex CLI has the stable `plugin add` command.  Use one
      // bounded command/exec compatibility bridge for that exact protocol
      // mismatch.  We deliberately do not retry after command/exec: an
      // unknown result must not become a duplicate external action.
      if (!isUnsupportedPluginInstallError(error)) throw error;
      response = await this.installPluginThroughCli(pluginName, marketplaceName);
    }
    const result = response.result && typeof response.result === "object"
      ? (response.result as Record<string, unknown>)
      : {};
    const appsNeedingAuth = Array.isArray(result.appsNeedingAuth)
      ? result.appsNeedingAuth.flatMap((value) => {
          if (!value || typeof value !== "object") return [];
          const app = value as Record<string, unknown>;
          const id = stringValue(app.id);
          const name = stringValue(app.name);
          if (!id || !name) return [];
          return [{
            id,
            name,
            category: stringValue(app.category) ?? null,
            description: stringValue(app.description) ?? null,
            installUrl: safeAuthUrl(app.installUrl)
          }];
        })
      : [];
    const authPolicy = result.authPolicy === "ON_INSTALL" || result.authPolicy === "ON_USE"
      ? result.authPolicy
      : null;
    if (result.__aosCliInstall === true) {
      const cliAuth = await this.readPluginAppsNeedingAuth(pluginName, marketplaceName);
      return {
        pluginName,
        marketplaceName,
        authPolicy,
        appsNeedingAuth: cliAuth
      };
    }
    return { pluginName, marketplaceName, authPolicy, appsNeedingAuth };
  }

  private async installPluginThroughCli(
    pluginName: string,
    marketplaceName: string | null
  ): Promise<Record<string, unknown>> {
    const pluginSpecifier = marketplaceName ? `${pluginName}@${marketplaceName}` : pluginName;
    const params: Record<string, unknown> = {
      // Keep this an argv array.  No shell is involved and the two dynamic
      // values have already passed bounded identifier validation above.
      command: ["codex", "plugin", "add", pluginSpecifier, "--json"],
      sandboxPolicy: { type: "externalSandbox", networkAccess: "enabled" }
    };
    this.applyCwd(params);
    const response = await this.request("command/exec", params);
    const result = response.result && typeof response.result === "object"
      ? response.result as Record<string, unknown>
      : {};
    const exitCode = typeof result.exitCode === "number" && Number.isSafeInteger(result.exitCode)
      ? result.exitCode
      : null;
    if (exitCode !== 0) {
      throw new Error(`codex_app_server_plugin_add_failed_code_${exitCode === null ? "unknown" : exitCode}`);
    }
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const metadata = parseJsonObjectFromCommandOutput(stdout);
    const returnedName = stringValue(metadata?.name);
    const returnedPluginId = stringValue(metadata?.pluginId);
    const returnedMarketplace = stringValue(metadata?.marketplaceName);
    const returnedAuthPolicy = metadata?.authPolicy === "ON_INSTALL" || metadata?.authPolicy === "ON_USE"
      ? metadata.authPolicy
      : null;
    if (returnedName !== pluginName || (marketplaceName && returnedMarketplace !== marketplaceName)) {
      throw new Error("codex_app_server_plugin_add_readback_mismatch");
    }
    if (returnedPluginId && returnedPluginId !== pluginSpecifier) {
      throw new Error("codex_app_server_plugin_add_readback_mismatch");
    }
    return {
      result: {
        __aosCliInstall: true,
        authPolicy: returnedAuthPolicy,
        // The CLI response is reduced to auth metadata only. Do not pass
        // installed paths, stderr, or arbitrary command output to the API.
        appsNeedingAuth: []
      }
    };
  }

  private async readPluginAppsNeedingAuth(
    pluginName: string,
    marketplaceName: string | null
  ): Promise<CodexAppServerPluginInstallResult["appsNeedingAuth"]> {
    const access = await this.readPluginAccess({
      pluginName,
      ...(marketplaceName ? { remoteMarketplaceName: marketplaceName } : {})
    });
    return access.apps
      .filter((app) => !app.accessStateAvailable || !app.isAccessible || !app.isEnabled)
      .map((app) => ({
        id: app.id,
        name: app.name ?? pluginName,
        category: null,
        description: null,
        installUrl: app.installUrl
      }));
  }

  async startTurn(input: {
    threadId: string;
    text: string;
    outputSchema?: Record<string, unknown>;
    onEvent?: (event: CodexAppServerEvent) => void;
  }): Promise<CodexAppServerTurnResult> {
    const threadId = input.threadId.trim();
    const text = redactSensitiveText(input.text).trim();
    if (!threadId) throw new Error("codex_app_server_thread_id_required");
    if (!text) throw new Error("codex_app_server_turn_text_required");
    await this.start();

    if (input.onEvent) this.pendingTurnListeners.set(threadId, input.onEvent);
    const params: Record<string, unknown> = {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      approvalPolicy: "never",
      // The thread was created with the built-in read-only sandbox. Omit a
      // turn-level profile override so the request remains compatible with
      // both the local and remote App Server protocol versions.
      ...(input.outputSchema ? { outputSchema: input.outputSchema } : {})
    };
    this.applyCwd(params);
    const responsePromise = this.request("turn/start", params);
    let response: Record<string, unknown>;
    try {
      response = await responsePromise;
    } finally {
      if (this.pendingTurnListeners.get(threadId) === input.onEvent) this.pendingTurnListeners.delete(threadId);
    }
    const turn = response.result && typeof response.result === "object"
      ? (response.result as Record<string, unknown>).turn
      : undefined;
    const turnId = turn && typeof turn === "object" ? (turn as Record<string, unknown>).id : undefined;
    if (typeof turnId !== "string" || !turnId.trim()) {
      throw new Error("codex_app_server_turn_id_missing");
    }

    const key = turnKey(threadId, turnId);
    this.turnToThread.set(turnId, threadId);
    if (input.onEvent) this.turnListeners.set(key, input.onEvent);
    try {
      const completed = await this.waitForCompletion(key);
      const turnEvents = this.turnEvents.get(key) ?? [];
      const textOutput = this.turnText.get(key) ?? "";
      const status = completionStatus(completed);
      const exactBlocker = status === "blocked" || status === "failed"
        ? completionError(completed) ?? "codex_app_server_turn_failed"
        : undefined;
      return {
        threadId,
        turnId,
        status,
        text: redactSensitiveText(textOutput).slice(0, 24_000),
        structured: parseStructuredText(textOutput),
        ...(this.turnProviderAccountHashes.has(key) ? { providerAccountHash: this.turnProviderAccountHashes.get(key)! } : {}),
        ...(this.turnProviderAccountHashes.has(key) ? { providerAccountHashSource: this.turnProviderAccountToolProof.has(key) ? "gmail_profile_tool" as const : "declared_output" as const } : {}),
      ...(this.turnGmailSummaryPages.has(key) ? { gmailSummaryPage: this.turnGmailSummaryPages.get(key)! } : {}),
        ...(this.turnGmailSourceMessages.has(key) ? { gmailSourceMessage: this.turnGmailSourceMessages.get(key)! } : {}),
        events: turnEvents.slice(-maxEventsPerTurn),
        exactBlocker
      };
    } finally {
      this.turnListeners.delete(key);
      this.turnProviderAccountHashes.delete(key);
      this.turnProviderAccountToolProof.delete(key);
      this.turnGmailSummaryPages.delete(key);
      this.turnGmailSourceMessages.delete(key);
    }
  }

  close(): void {
    this.closed = true;
    this.initialized = false;
    this.connection = null;
    this.rejectAll(new Error("codex_app_server_closed"));
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.kill("SIGTERM");
    } catch {
      // The worker owns this process; a close race is already terminal.
    }
  }

  private async startInternal(): Promise<void> {
    this.closed = false;
    const connection = resolveCodexAppServerConnection(this.options, process.env);
    this.connection = connection;
    let child: AppServerChildLike;
    if (connection.mode === "remote_websocket") {
      child = await createRemoteAppServerChild(connection, this.options.webSocketFactory);
    } else {
      const command = selectAppServerCommand(this.options);
      if (!command) throw new Error("codex_app_server_command_missing");
      const cwd = appServerCwd(this.options.cwd, this.options.workspaceRoot ?? process.env.AUTOMATION_OS_WORKER_WORKSPACE_ROOT);
      const factory = this.options.processFactory ?? (spawn as unknown as AppServerProcessFactory);
      try {
        child = factory(command, ["app-server", "--listen", "stdio://"], {
          cwd,
          env: safeAppServerEnvironment(process.env),
          stdio: ["pipe", "pipe", "pipe"]
        });
      } catch {
        throw new Error("codex_app_server_spawn_failed");
      }
    }
    this.child = child;
    const onData = (chunk: Buffer | string) => this.consumeStdout(chunk);
    const onError = () => this.failConnection(new Error("codex_app_server_process_error"));
    const onClose = () => this.failConnection(new Error("codex_app_server_process_closed"));
    child.stdout.on("data", onData);
    child.stderr.on("data", () => {
      // stderr is intentionally not persisted or exposed.
    });
    child.stdin.on("error", onError);
    child.on("error", onError);
    child.once("close", onClose);

    const initialize = await this.request("initialize", {
      clientInfo: { name: "automation_os", title: "Automation OS", version: "0.1.0" },
      capabilities: {}
    });
    if (!initialize.result || initialize.error) throw new Error("codex_app_server_initialize_rejected");
    this.write({ method: "initialized", params: {} });
    this.initialized = true;
  }

  private applyCwd(params: Record<string, unknown>): void {
    if (this.connection?.mode === "remote_websocket") {
      const remoteCwd = remoteWorkspaceCwd(this.connection);
      if (remoteCwd) params.cwd = remoteCwd;
      return;
    }
    params.cwd = appServerCwd(this.options.cwd, this.options.workspaceRoot ?? process.env.AUTOMATION_OS_WORKER_WORKSPACE_ROOT);
  }

  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const child = this.child;
    if (!child || this.closed) return Promise.reject(new Error("codex_app_server_unavailable"));
    const id = this.nextRequestId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method.replaceAll("/", "_")}_timeout`));
      }, boundedTimeout(this.options.timeoutMs));
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        void error;
        reject(new Error("codex_app_server_write_failed"));
      }
    });
  }

  private waitForCompletion(key: string): Promise<Record<string, unknown>> {
    const existing = this.recentCompletions.get(key);
    if (existing) {
      this.recentCompletions.delete(key);
      return Promise.resolve(existing);
    }
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.completions.delete(key);
        reject(new Error("codex_app_server_turn_timeout"));
      }, boundedTurnTimeout(this.options.turnTimeoutMs, this.options.timeoutMs));
      timer.unref?.();
      this.completions.set(key, { resolve, reject, timer });
    });
  }

  private write(message: Record<string, unknown>): void {
    const child = this.child;
    if (!child || this.closed) throw new Error("codex_app_server_unavailable");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private consumeStdout(chunk: Buffer | string): void {
    this.lineBuffer += String(chunk);
    while (true) {
      const newline = this.lineBuffer.indexOf("\n");
      if (newline < 0) {
        // The buffer may contain several valid JSONL messages in one stdout
        // chunk. Enforce the limit on an incomplete *single* line only; the
        // total size of multiple complete lines is not a protocol violation.
        if (Buffer.byteLength(this.lineBuffer, "utf8") > maxLineBytes) {
          this.failConnection(new Error("codex_app_server_protocol_line_too_large"));
        }
        return;
      }
      const rawLine = this.lineBuffer.slice(0, newline);
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      if (Buffer.byteLength(rawLine, "utf8") > maxLineBytes) {
        this.failConnection(new Error("codex_app_server_protocol_line_too_large"));
        return;
      }
      const line = rawLine.trim();
      if (!line) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        this.failConnection(new Error("codex_app_server_protocol_error"));
        return;
      }
      if (typeof message.method === "string" && typeof message.id === "number") this.handleServerRequest(message);
      else if (typeof message.id === "number") this.resolveResponse(message);
      else if (typeof message.method === "string") this.handleNotification(message);
    }
  }

  private resolveResponse(message: JsonRpcMessage): void {
    const pending = this.pending.get(message.id!);
    if (!pending) return;
    this.pending.delete(message.id!);
    clearTimeout(pending.timer);
    if (message.error) {
      // Preserve only the protocol error code in the surfaced blocker. The
      // remote server's message may contain paths, URLs, or provider data;
      // exposing it would turn a useful diagnostic into an accidental data
      // leak. The numeric code is enough to distinguish unsupported methods,
      // invalid params, and provider-side rejection without revealing the
      // payload.
      const code = typeof message.error.code === "number" && Number.isSafeInteger(message.error.code)
        ? String(message.error.code)
        : "unknown";
      pending.reject(new Error(`codex_app_server_request_rejected_code_${code}`));
      return;
    }
    pending.resolve({ result: message.result, error: message.error });
  }

  private handleNotification(message: JsonRpcMessage): void {
    const params = message.params ?? {};
    const capturedAt = new Date().toISOString();
    if (message.method === "account/login/completed") {
      this.authLoginCompletion = {
        loginId: stringValue(params.loginId) ?? null,
        success: params.success === true,
        error: stringValue(params.error) ?? null,
        capturedAt
      };
    } else if (message.method === "account/updated") {
      this.authAccountUpdated = {
        authMode: stringValue(params.authMode) ?? null,
        planType: stringValue(params.planType) ?? null,
        capturedAt
      };
    }
    const notificationTurnId = stringValue(params.turnId) ?? nestedString(params.turn, "id");
    const threadId = stringValue(params.threadId) ?? (notificationTurnId ? this.turnToThread.get(notificationTurnId) : undefined);
    const turnId = notificationTurnId;
    const eventItem = params.item && typeof params.item === "object" ? params.item as Record<string, unknown> : undefined;
    const itemId = stringValue(params.itemId) ?? nestedString(params.item, "id");
    const itemType = nestedString(eventItem, "type");
    const toolName = nestedString(eventItem, "tool")
      ?? nestedString(eventItem, "name")
      ?? nestedString(eventItem, "toolName")
      ?? nestedString(eventItem, "tool_name")
      ?? nestedString(eventItem, "serverName")
      ?? nestedString(eventItem, "server_name");
    const event: CodexAppServerEvent = {
      method: message.method!,
      ...(threadId ? { threadId } : {}),
      ...(turnId ? { turnId } : {}),
      ...(itemId ? { itemId } : {}),
      ...(eventItem?.arguments && typeof eventItem.arguments === "object" && !Array.isArray(eventItem.arguments) ? { toolArguments: eventItem.arguments as Record<string, unknown> } : {}),
      ...(itemType ? { itemType } : {}),
      ...(toolName ? { toolName: redactSensitiveText(toolName).slice(0, 120) } : {}),
      ...(nestedString(eventItem, "server") ? { serverName: redactSensitiveText(nestedString(eventItem, "server")!).slice(0, 120) } : {}),
      ...(message.method === "item/agentMessage/delta" && stringValue(params.delta)
        ? { delta: redactSensitiveText(stringValue(params.delta)!).slice(0, 4_000) }
        : {}),
      ...(nestedString(eventItem, "status") || nestedString(params.turn, "status") ? { status: nestedString(eventItem, "status") ?? nestedString(params.turn, "status") } : {}),
      capturedAt
    };
    const key = threadId && turnId ? turnKey(threadId, turnId) : undefined;
    if (key) {
      // MCP content can be only "Success" while the authenticated identity is
      // in structuredContent, which is not necessarily shown to the model.
      // Compare the actual profile result, never ask the model to invent it.
      if (message.method === "item/completed" && isToolCallItemType(itemType)
        && event.status === "completed" && eventItem?.error == null
        && `${event.serverName ?? ""} ${toolName ?? ""}`.toLowerCase().includes("gmail")
        && /(?:get_)?profile$/i.test(toolName ?? "")) {
        const result = eventItem?.result as Record<string, unknown> | undefined;
        const profile = (result?.structuredContent ?? result?.structured_content) as Record<string, unknown> | undefined;
        const email = profile?.email ?? profile?.emailAddress ?? profile?.email_address;
        if (typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
          this.turnProviderAccountHashes.set(key, createHash("sha256").update(email.trim().toLowerCase(), "utf8").digest("hex"));
          this.turnProviderAccountToolProof.add(key);
        }
      }
      const events = this.turnEvents.get(key) ?? [];
      if (message.method === "item/completed" && isToolCallItemType(itemType) && event.status === "completed"
        && eventItem?.error == null && toolName === "gmail.search_emails") {
        const result = eventItem?.result as Record<string, unknown> | undefined;
        const page = (result?.structuredContent ?? result?.structured_content) as Record<string, unknown> | undefined;
        const args = eventItem?.arguments as Record<string, unknown> | undefined;
        if (Array.isArray(page?.emails) && page.emails.every((mail: any) => typeof mail?.id === "string" && mail.id.trim())) {
          this.turnGmailSummaryPages.set(key, {
            messages: page.emails.slice(0, 100).map((mail: any) => ({ id: mail.id.trim().slice(0, 200), subject: redactSensitiveText(String(mail.subject ?? "")).slice(0, 140), snippet: redactSensitiveText(String(mail.snippet ?? "")).slice(0, 240) })),
            nextPageToken: typeof page.next_page_token === "string" && page.next_page_token ? page.next_page_token : null,
            unfiltered: (!args?.query || args.query === "") && (!Array.isArray(args?.label_ids) || args.label_ids.length === 0)
          });
        }
      }
      if (message.method === "item/completed" && itemType === "mcpToolCall" && event.status === "completed"
        && eventItem?.error == null && /gmail[._]read_email$/i.test(toolName ?? "")) {
        const result = eventItem?.result as Record<string, unknown> | undefined;
        const structured = result?.structuredContent as Record<string, unknown> | undefined;
        const messageResult = structured?.result as Record<string, unknown> | undefined;
        const payload = messageResult?.payload as Record<string, unknown> | undefined;
        const headers = Array.isArray(payload?.headers) ? payload.headers.flatMap((header) => {
          if (!header || typeof header !== "object") return [];
          const value = header as Record<string, unknown>;
          return typeof value.name === "string" && typeof value.value === "string"
            ? [{ name: value.name, value: value.value }] : [];
        }) : [];
        if (typeof messageResult?.id === "string" && typeof messageResult.thread_id === "string" && headers.length > 0) {
          this.turnGmailSourceMessages.set(key, { id: messageResult.id.trim(), thread_id: messageResult.thread_id.trim(), payload: { headers },
            ...(typeof messageResult.history_id === "string" ? { history_id: messageResult.history_id } : {}),
            ...(Array.isArray(messageResult.label_ids) && messageResult.label_ids.every((label) => typeof label === "string") ? { label_ids: messageResult.label_ids as string[] } : {}) });
        }
      }
      events.push(event);
      this.turnEvents.set(key, events.slice(-maxEventsPerTurn));
      if (message.method === "item/agentMessage/delta" && event.delta) {
        this.turnText.set(key, `${this.turnText.get(key) ?? ""}${event.delta}`.slice(-24_000));
      }
      if (message.method === "item/completed") {
        const item = params.item;
        if (item && typeof item === "object" && nestedString(item as Record<string, unknown>, "type") === "agentMessage") {
          const finalText = nestedString(item as Record<string, unknown>, "text");
          if (finalText) {
            const account = parseStructuredText(finalText)?.provider_account;
            if (!this.turnProviderAccountToolProof.has(key) && typeof account === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.trim())) {
              this.turnProviderAccountHashes.set(key, createHash("sha256").update(account.trim().toLowerCase(), "utf8").digest("hex"));
            }
            this.turnText.set(key, redactSensitiveText(finalText).slice(-24_000));
          }
        }
      }
      if (message.method === "turn/completed") {
        const waiter = this.completions.get(key);
        if (waiter) {
          this.completions.delete(key);
          clearTimeout(waiter.timer);
          waiter.resolve(params);
        } else {
          this.recentCompletions.set(key, params);
        }
      }
    }
    this.emitEvent(this.options.onEvent, event);
    if (key) this.emitEvent(this.turnListeners.get(key) ?? this.pendingTurnListeners.get(threadId ?? ""), event);
  }

  private emitEvent(listener: ((event: CodexAppServerEvent) => void) | undefined, event: CodexAppServerEvent): void {
    if (!listener) return;
    try {
      listener(event);
    } catch {
      // Progress observers must not break the worker-owned protocol stream.
    }
  }

  private handleServerRequest(message: JsonRpcMessage): void {
    // This client has no external-effect authority. Never approve or execute.
    try {
      this.write({ id: message.id, error: { code: -32000, message: "automation_os_approval_not_available" } });
    } catch {
      // The connection failure will reject the active turn.
    }
  }

  private failConnection(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.initialized = false;
    this.connection = null;
    const child = this.child;
    this.child = null;
    this.rejectAll(error);
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {
        // The process is already gone or closing.
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    for (const [key, waiter] of this.completions) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
      this.completions.delete(key);
    }
  }
}

async function createRemoteAppServerChild(
  connection: ResolvedCodexAppServerConnection,
  factory?: AppServerWebSocketFactory
): Promise<AppServerChildLike> {
  if (!connection.token) throw new Error("codex_app_server_remote_auth_missing");
  const socketFactory = factory ?? defaultAppServerWebSocketFactory;
  let socket: AppServerWebSocketLike;
  try {
    socket = socketFactory(connection.endpoint, { headers: { Authorization: `Bearer ${connection.token}` } });
  } catch {
    throw new Error("codex_app_server_remote_connect_failed");
  }
  const child = webSocketChild(socket);
  await waitForWebSocketOpen(socket);
  return child;
}

function defaultAppServerWebSocketFactory(
  url: string,
  init: { headers: Record<string, string> }
): AppServerWebSocketLike {
  // Node's WHATWG WebSocket constructor does not provide a portable way to
  // set an Authorization header. The `ws` client does, and Codex App Server's
  // capability-token mode requires that header on the WebSocket handshake.
  const socket = new WebSocket(url, { headers: init.headers });
  return adaptNodeWebSocket(socket);
}

function adaptNodeWebSocket(socket: WebSocket): AppServerWebSocketLike {
  return {
    addEventListener(event, listener, options) {
      const once = options?.once === true;
      if (event === "open") {
        const handler = () => listener({});
        once ? socket.once("open", handler) : socket.on("open", handler);
        return;
      }
      if (event === "message") {
        const handler = (data: unknown) => listener({ data: normalizeNodeWebSocketData(data) });
        once ? socket.once("message", handler) : socket.on("message", handler);
        return;
      }
      if (event === "error") {
        const handler = () => listener({});
        once ? socket.once("error", handler) : socket.on("error", handler);
        return;
      }
      const handler = (code: number, reason: Buffer) => listener({
        code,
        reason: reason.toString("utf8")
      });
      once ? socket.once("close", handler) : socket.on("close", handler);
    },
    send(data) {
      socket.send(data);
    },
    close(code, reason) {
      socket.close(code, reason);
    }
  };
}

function normalizeNodeWebSocketData(value: unknown): string | ArrayBuffer {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof ArrayBuffer) return value;
  if (Array.isArray(value) && value.every((item) => Buffer.isBuffer(item))) {
    return Buffer.concat(value).toString("utf8");
  }
  return String(value);
}

function waitForWebSocketOpen(socket: AppServerWebSocketLike): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    socket.addEventListener("open", () => finish());
    socket.addEventListener("error", () => finish(new Error("codex_app_server_remote_connect_failed")));
    socket.addEventListener("close", () => finish(new Error("codex_app_server_remote_connect_failed")));
  });
}

function webSocketChild(socket: AppServerWebSocketLike): AppServerChildLike {
  const dataListeners = new Set<(chunk: Buffer | string) => void>();
  const errorListeners = new Set<(error: Error) => void>();
  const closeListeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();
  let closed = false;
  const emitError = (error: Error) => {
    for (const listener of errorListeners) listener(error);
  };
  const emitClose = (code: number | null, signal: NodeJS.Signals | null) => {
    if (closed) return;
    closed = true;
    for (const listener of closeListeners) listener(code, signal);
  };
  socket.addEventListener("message", (event) => {
    const data = event.data;
    if (typeof data === "string") {
      for (const listener of dataListeners) listener(`${data}\n`);
      return;
    }
    if (data instanceof ArrayBuffer) {
      const text = Buffer.from(data).toString("utf8");
      for (const listener of dataListeners) listener(`${text}\n`);
      return;
    }
    if (data && typeof data === "object" && "text" in data && typeof (data as { text?: unknown }).text === "function") {
      void (data as { text: () => Promise<string> }).text().then((text) => {
        for (const listener of dataListeners) listener(`${text}\n`);
      }).catch(() => emitError(new Error("codex_app_server_remote_message_failed")));
      return;
    }
    emitError(new Error("codex_app_server_remote_protocol_error"));
  });
  socket.addEventListener("error", () => emitError(new Error("codex_app_server_remote_socket_error")));
  socket.addEventListener("close", (event) => emitClose(typeof event.code === "number" ? event.code : null, null));

  const stdin: WritableLike = {
    write(chunk: string): boolean {
      if (closed) throw new Error("codex_app_server_remote_socket_closed");
      socket.send(chunk);
      return true;
    },
    on(): unknown { return stdin; },
    removeListener(): unknown { return stdin; }
  };
  const stdout: ReadableLike = {
    on(event: "data", listener: (chunk: Buffer | string) => void): unknown {
      dataListeners.add(listener);
      return stdout;
    },
    removeListener(event: "data", listener: (chunk: Buffer | string) => void): unknown {
      dataListeners.delete(listener);
      return stdout;
    }
  };
  const stderr: ReadableLike = { on(): unknown { return stderr; }, removeListener(): unknown { return stderr; } };
  return {
    stdin,
    stdout,
    stderr,
    on(event: "error", listener: (error: Error) => void): unknown {
      errorListeners.add(listener);
      return this;
    },
    once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown {
      const onceListener = (code: number | null, signal: NodeJS.Signals | null) => {
        closeListeners.delete(onceListener);
        listener(code, signal);
      };
      closeListeners.add(onceListener);
      return this;
    },
    removeListener(event: "error" | "close", listener: ((error: Error) => void) | ((code: number | null, signal: NodeJS.Signals | null) => void)): unknown {
      if (event === "error") errorListeners.delete(listener as (error: Error) => void);
      else closeListeners.delete(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
      return this;
    },
    kill(): boolean {
      if (closed) return false;
      socket.close(1000, "automation_os_client_close");
      emitClose(1000, null);
      return true;
    }
  };
}

export function safeAppServerEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set([
    "PATH", "HOME", "CODEX_HOME", "CODEX_CLI_PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM",
    "USER", "LOGNAME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"
  ]);
  const output: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(input)) {
    if (allowed.has(key) && typeof value === "string") output[key] = value;
  }
  output.AUTOMATION_OS_CODEX_APP_SERVER_CHILD = "1";
  return output;
}

export function selectAppServerCommand(
  options: { command?: string } = {},
  env: NodeJS.ProcessEnv = process.env
): string {
  return options.command?.trim()
    || env.AUTOMATION_OS_CODEX_APP_SERVER_COMMAND?.trim()
    || env.AUTOMATION_OS_CODEX_BIN?.trim()
    || env.CODEX_CLI_PATH?.trim()
    || "codex";
}

function boundedTimeout(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value <= 0) return defaultTimeoutMs;
  return Math.min(Math.floor(value), maxTimeoutMs);
}

function boundedTurnTimeout(turnTimeoutMs: number | undefined, rpcTimeoutMs: number | undefined): number {
  if (turnTimeoutMs === undefined) return boundedTimeout(rpcTimeoutMs);
  if (!Number.isFinite(turnTimeoutMs) || !turnTimeoutMs || turnTimeoutMs <= 0) return defaultTimeoutMs;
  return Math.min(Math.floor(turnTimeoutMs), maxTurnTimeoutMs);
}

function appServerCwd(value: string | undefined, workspaceRootValue: string | undefined): string {
  return resolveBoundedWorkspacePath(value, workspaceRootValue, {
    rootInvalid: "codex_app_server_workspace_root_invalid",
    pathInvalid: "codex_app_server_cwd_invalid",
    outside: "codex_app_server_cwd_outside_workspace"
  });
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isToolCallItemType(value: string | undefined): boolean {
  const normalized = value?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
  return normalized === "mcptoolcall" || normalized === "dynamictoolcall";
}

function boundedPluginName(value: string, requiredCode: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(requiredCode);
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(normalized)) throw new Error("codex_app_server_plugin_name_invalid");
  return normalized;
}

export function normalizeMarketplaceName(value: string): string {
  const normalized = boundedPluginName(value, "codex_app_server_marketplace_name_invalid");
  // The dedicated App Server's configured marketplace is the canonical
  // `openai-curated` name.  Do not rewrite it to the historical
  // `openai-curated-remote` alias: the remote protocol validates the exact
  // configured marketplace name and rejects the alias as an invalid request.
  return normalized === "openai-curated-remote" ? "openai-curated" : normalized;
}

function isUnsupportedPluginInstallError(error: unknown): boolean {
  return error instanceof Error && error.message === "codex_app_server_request_rejected_code_-32600";
}

function parseJsonObjectFromCommandOutput(value: string): Record<string, unknown> | null {
  const bounded = value.trim().slice(0, 64 * 1024);
  if (!bounded) return null;
  try {
    const parsed = JSON.parse(bounded) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    // Some CLI wrappers prepend a short informational line even with
    // --json. Parse only the first bounded JSON object and never expose the
    // surrounding output.
    const start = bounded.indexOf("{");
    const end = bounded.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(bounded.slice(start, end + 1)) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }
}

function boundedDeviceCode(value: unknown): string | undefined {
  const normalized = stringValue(value);
  if (!normalized || normalized.length > 64 || !/^[a-z0-9-]+$/iu.test(normalized)) return undefined;
  return normalized;
}

function safeAuthUrl(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"))) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function nestedString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  return stringValue((value as Record<string, unknown>)[key]);
}

function completionStatus(params: Record<string, unknown>): CodexAppServerTurnResult["status"] {
  const status = nestedString(params.turn, "status");
  if (status === "completed") return "completed";
  if (status === "interrupted") return "interrupted";
  if (status === "failed") return "failed";
  return "blocked";
}

function completionError(params: Record<string, unknown>): string | undefined {
  const error = params.turn && typeof params.turn === "object" ? (params.turn as Record<string, unknown>).error : undefined;
  if (!error || typeof error !== "object") return undefined;
  return "codex_app_server_turn_failed";
}

function parseStructuredText(text: string): Record<string, unknown> | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/iu, "").trim();
  const candidates = [trimmed];
  // Some App Server/model combinations add a short preamble or trailing
  // sentence even when an output schema was requested. Recover only the
  // first balanced JSON object; callers still validate its complete shape.
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace && (firstBrace > 0 || lastBrace < trimmed.length - 1)) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Try the next bounded candidate.
    }
  }
  return null;
}

import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, posix } from "node:path";

export type CodexAppServerConnectionMode = "local_stdio" | "remote_websocket";

export type CodexAppServerConnectionBlocker =
  | "codex_app_server_remote_url_invalid"
  | "codex_app_server_remote_tls_required"
  | "codex_app_server_remote_auth_missing"
  | "codex_app_server_remote_auth_unresolved_reference"
  | "codex_app_server_remote_cwd_invalid";

export const codexAppServerRemotePromotionBlocker =
  "codex_app_server_remote_transport_experimental_unsupported" as const;

export type CodexAppServerTransportSupport =
  | "supported_local_stdio"
  | "experimental_remote_websocket";

export type CodexAppServerConnectionReadback = {
  schema: "codex_app_server_connection_readback.v1";
  mode: CodexAppServerConnectionMode;
  configured: boolean;
  endpoint: string;
  tls_required: boolean;
  network_boundary: "local_stdio" | "zeabur_private_service" | "tls_remote";
  auth_configured: boolean;
  local_stdio_fallback: boolean;
  exact_blocker: CodexAppServerConnectionBlocker | null;
  transport_support: CodexAppServerTransportSupport;
  production_remote_cutover_allowed: boolean | null;
  production_promotion_blocker: CodexAppServerConnectionBlocker | typeof codexAppServerRemotePromotionBlocker | null;
};

export type ResolvedCodexAppServerConnection = {
  mode: CodexAppServerConnectionMode;
  endpoint: string;
  token?: string;
  remoteCwd?: string;
};

export type CodexAppServerConnectionOptions = {
  remoteUrl?: string;
  remoteToken?: string;
  remoteCwd?: string;
  allowInternalServiceWs?: boolean;
};

const remoteUrlEnv = "AUTOMATION_OS_CODEX_APP_SERVER_REMOTE_URL";
const remoteTokenEnv = "AUTOMATION_OS_CODEX_APP_SERVER_REMOTE_TOKEN";
const remoteTokenFileEnv = "AUTOMATION_OS_CODEX_APP_SERVER_REMOTE_TOKEN_FILE";
const remoteCwdEnv = "AUTOMATION_OS_CODEX_APP_SERVER_REMOTE_CWD";
const internalWsAllowedEnv = "AUTOMATION_OS_CODEX_APP_SERVER_ALLOW_INTERNAL_WS";
const codexAppServerInternalHost = "codex-app-server.zeabur.internal";

export function resolveCodexAppServerConnection(
  options: CodexAppServerConnectionOptions = {},
  env: NodeJS.ProcessEnv = process.env
): ResolvedCodexAppServerConnection {
  const rawUrl = options.remoteUrl?.trim() || env[remoteUrlEnv]?.trim() || "";
  if (!rawUrl) return { mode: "local_stdio", endpoint: "stdio://" };

  const parsed = parseRemoteUrl(rawUrl, allowInternalServiceWs(options, env));
  const token = resolveRemoteToken(options, env);
  if (!token) throw new Error("codex_app_server_remote_auth_missing");

  const remoteCwd = options.remoteCwd?.trim() || env[remoteCwdEnv]?.trim() || undefined;
  if (remoteCwd !== undefined) validateRemoteCwd(remoteCwd);

  return {
    mode: "remote_websocket",
    endpoint: parsed.toString(),
    token,
    ...(remoteCwd ? { remoteCwd } : {})
  };
}

export function getCodexAppServerConnectionReadback(
  options: CodexAppServerConnectionOptions = {},
  env: NodeJS.ProcessEnv = process.env
): CodexAppServerConnectionReadback {
  const rawUrl = options.remoteUrl?.trim() || env[remoteUrlEnv]?.trim() || "";
  if (!rawUrl) {
    return {
      schema: "codex_app_server_connection_readback.v1",
      mode: "local_stdio",
      configured: true,
      endpoint: "stdio://",
      tls_required: false,
      network_boundary: "local_stdio",
      auth_configured: false,
      local_stdio_fallback: true,
      exact_blocker: null,
      transport_support: "supported_local_stdio",
      production_remote_cutover_allowed: null,
      production_promotion_blocker: null
    };
  }

  let parsed: URL;
  try {
    parsed = parseRemoteUrl(rawUrl, allowInternalServiceWs(options, env));
  } catch (error) {
    const blocker = blockerFromError(error, "codex_app_server_remote_url_invalid");
    return remoteReadback(
      rawUrl,
      remoteTlsRequiredForRawUrl(rawUrl),
      networkBoundaryForRawUrl(rawUrl),
      Boolean(options.remoteToken?.trim() || env[remoteTokenEnv]?.trim()),
      blocker
    );
  }

  let token = "";
  try {
    token = resolveRemoteToken(options, env);
  } catch (error) {
    return remoteReadback(
      parsed.toString(),
      !isCodexAppServerInternalUrl(parsed),
      networkBoundaryForParsedUrl(parsed),
      false,
      blockerFromError(error, "codex_app_server_remote_auth_missing")
    );
  }
  if (!token) {
    return remoteReadback(
      parsed.toString(),
      !isCodexAppServerInternalUrl(parsed),
      networkBoundaryForParsedUrl(parsed),
      false,
      "codex_app_server_remote_auth_missing"
    );
  }

  try {
    const remoteCwd = options.remoteCwd?.trim() || env[remoteCwdEnv]?.trim();
    if (remoteCwd) validateRemoteCwd(remoteCwd);
  } catch (error) {
    return remoteReadback(
      parsed.toString(),
      !isCodexAppServerInternalUrl(parsed),
      networkBoundaryForParsedUrl(parsed),
      true,
      blockerFromError(error, "codex_app_server_remote_cwd_invalid")
    );
  }

  return remoteReadback(
    parsed.toString(),
    !isCodexAppServerInternalUrl(parsed),
    networkBoundaryForParsedUrl(parsed),
    true,
    null
  );
}

export function remoteWorkspaceCwd(
  connection: ResolvedCodexAppServerConnection
): string | undefined {
  return connection.mode === "remote_websocket" ? connection.remoteCwd : undefined;
}

/** Reports only whether a remote auth value can be resolved. */
export function hasCodexAppServerRemoteAuth(
  options: CodexAppServerConnectionOptions = {},
  env: NodeJS.ProcessEnv = process.env
): boolean {
  try {
    return Boolean(resolveRemoteToken(options, env));
  } catch {
    return false;
  }
}

function resolveRemoteToken(
  options: CodexAppServerConnectionOptions,
  env: NodeJS.ProcessEnv
): string {
  const direct = options.remoteToken?.trim() || env[remoteTokenEnv]?.trim() || "";
  if (direct) {
    if (isUnresolvedSecretReference(direct)) throw new Error("codex_app_server_remote_auth_unresolved_reference");
    return direct;
  }

  const tokenFile = env[remoteTokenFileEnv]?.trim() || "";
  if (!tokenFile) return "";
  if (!isAbsolute(tokenFile)) throw new Error("codex_app_server_remote_auth_missing");

  let stat;
  try {
    stat = lstatSync(tokenFile);
  } catch {
    throw new Error("codex_app_server_remote_auth_missing");
  }
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw new Error("codex_app_server_remote_auth_missing");
  }

  let value = "";
  try {
    value = readFileSync(tokenFile, "utf8").trim();
  } catch {
    throw new Error("codex_app_server_remote_auth_missing");
  }
  if (!value) throw new Error("codex_app_server_remote_auth_missing");
  if (isUnresolvedSecretReference(value)) throw new Error("codex_app_server_remote_auth_unresolved_reference");
  return value;
}

function isUnresolvedSecretReference(value: string): boolean {
  return /^\$\{[^{}]+\}$/u.test(value);
}

function parseRemoteUrl(rawUrl: string, allowInternalServiceWs: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("codex_app_server_remote_url_invalid");
  }
  if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") {
    throw new Error("codex_app_server_remote_url_invalid");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.hostname) {
    throw new Error("codex_app_server_remote_url_invalid");
  }
  if (parsed.protocol === "ws:" && !isLoopbackHost(parsed.hostname) && !(allowInternalServiceWs && isCodexAppServerInternalUrl(parsed))) {
    throw new Error("codex_app_server_remote_tls_required");
  }
  return parsed;
}

function allowInternalServiceWs(
  options: CodexAppServerConnectionOptions,
  env: NodeJS.ProcessEnv
): boolean {
  return options.allowInternalServiceWs ?? env[internalWsAllowedEnv]?.trim() === "1";
}

function isCodexAppServerInternalUrl(parsed: URL): boolean {
  return parsed.protocol === "ws:" && parsed.hostname.toLowerCase() === codexAppServerInternalHost;
}

function validateRemoteCwd(value: string): void {
  if (!isAbsolute(value) || value.includes("\0")) throw new Error("codex_app_server_remote_cwd_invalid");
  const normalized = posix.normalize(value);
  if (normalized !== value && normalized !== `${value}/`) throw new Error("codex_app_server_remote_cwd_invalid");
  if (value.split("/").includes("..")) throw new Error("codex_app_server_remote_cwd_invalid");
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function remoteTlsRequiredForRawUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "ws:" && !isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

function networkBoundaryForParsedUrl(parsed: URL): "zeabur_private_service" | "tls_remote" {
  return isCodexAppServerInternalUrl(parsed) ? "zeabur_private_service" : "tls_remote";
}

function networkBoundaryForRawUrl(rawUrl: string): "zeabur_private_service" | "tls_remote" {
  try {
    return networkBoundaryForParsedUrl(new URL(rawUrl));
  } catch {
    return "tls_remote";
  }
}

function remoteReadback(
  endpoint: string,
  tlsRequired: boolean,
  networkBoundary: "zeabur_private_service" | "tls_remote",
  authConfigured: boolean,
  exactBlocker: CodexAppServerConnectionBlocker | null
): CodexAppServerConnectionReadback {
  return {
    schema: "codex_app_server_connection_readback.v1",
    mode: "remote_websocket",
    configured: true,
    endpoint: redactEndpoint(endpoint),
    tls_required: tlsRequired,
    network_boundary: networkBoundary,
    auth_configured: authConfigured,
    local_stdio_fallback: false,
    exact_blocker: exactBlocker,
    transport_support: "experimental_remote_websocket",
    production_remote_cutover_allowed: false,
    production_promotion_blocker: exactBlocker ?? codexAppServerRemotePromotionBlocker
  };
}

function redactEndpoint(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname || "/"}`;
  } catch {
    return "invalid://redacted";
  }
}

function blockerFromError(error: unknown, fallback: CodexAppServerConnectionBlocker): CodexAppServerConnectionBlocker {
  const value = error instanceof Error ? error.message : "";
  if (value === "codex_app_server_remote_tls_required") return value;
  if (value === "codex_app_server_remote_auth_missing") return value;
  if (value === "codex_app_server_remote_auth_unresolved_reference") return value;
  if (value === "codex_app_server_remote_cwd_invalid") return value;
  return fallback;
}

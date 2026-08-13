import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { readStoredSecret } from "../secrets/secretStore.js";
import { secureTokenEqual } from "./tokenComparison.js";

export const AUTH_SESSION_COOKIE_NAME = "aos_session";
export const AUTH_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

export type AuthScope = "read" | "write" | "unrestricted" | "unknown";
export type AuthMethod = "session_cookie" | "service_identity" | "header_token" | "unrestricted" | "none";
export type AuthSecretKind = "service_identity" | "read" | "write" | "session" | "private_ingress";
export type AuthSecretSource = "environment" | "file" | "keychain" | "secret_store" | "derived" | "none";

export type ServerAuthStatus = {
  required: boolean;
  sessionConfigured: boolean;
  privateIngressConfigured: boolean;
  serviceIdentityConfigured: boolean;
  readTokenConfigured: boolean;
  writeTokenConfigured: boolean;
  tokenConfigured: boolean;
  sessionSource: AuthSecretSource;
  privateIngressSource: AuthSecretSource;
  serviceIdentitySource: AuthSecretSource;
  readTokenSource: AuthSecretSource;
  writeTokenSource: AuthSecretSource;
};

export type RequestAuth = {
  scope: AuthScope;
  method: AuthMethod;
  tokenPresented: boolean;
};

type SecretResolution = { value: string; source: AuthSecretSource };
type KeychainRunner = (command: string, args: string[], options: Record<string, unknown>) => {
  status?: number | null;
  stdout?: string | Buffer;
};

const READ_TOKEN_ENV_NAMES = [
  "AUTOMATION_OS_READ_TOKEN",
  "AUTOMATION_OS_QA_READ_TOKEN",
  "AUTOMATION_OS_REPLAY_READ_TOKEN"
] as const;

const READ_TOKEN_FILE_ENV_NAMES = [
  "AUTOMATION_OS_READ_TOKEN_FILE",
  "AUTOMATION_OS_QA_READ_TOKEN_FILE",
  "AUTOMATION_OS_REPLAY_READ_TOKEN_FILE"
] as const;

const SECRET_CONFIG: Record<AuthSecretKind, {
  envNames: readonly string[];
  fileNames: readonly string[];
  storedIdNames: readonly string[];
  keychainServiceNames: readonly string[];
  defaultKeychainService: string;
}> = {
  service_identity: {
    envNames: ["AUTOMATION_OS_SERVICE_IDENTITY_TOKEN"],
    fileNames: ["AUTOMATION_OS_SERVICE_IDENTITY_TOKEN_FILE"],
    storedIdNames: ["AUTOMATION_OS_SERVICE_IDENTITY_SECRET_ID"],
    keychainServiceNames: ["AUTOMATION_OS_SERVICE_IDENTITY_KEYCHAIN_SERVICE"],
    defaultKeychainService: "Automation OS automation-3 service identity"
  },
  read: {
    envNames: READ_TOKEN_ENV_NAMES,
    fileNames: READ_TOKEN_FILE_ENV_NAMES,
    storedIdNames: ["AUTOMATION_OS_READ_TOKEN_SECRET_ID"],
    keychainServiceNames: ["AUTOMATION_OS_READ_TOKEN_KEYCHAIN_SERVICE"],
    defaultKeychainService: "Automation OS read token"
  },
  write: {
    envNames: ["AUTOMATION_OS_WRITE_TOKEN"],
    fileNames: ["AUTOMATION_OS_WRITE_TOKEN_FILE"],
    storedIdNames: ["AUTOMATION_OS_WRITE_TOKEN_SECRET_ID"],
    keychainServiceNames: ["AUTOMATION_OS_WRITE_TOKEN_KEYCHAIN_SERVICE"],
    defaultKeychainService: "Automation OS write token"
  },
  session: {
    envNames: ["AUTOMATION_OS_SESSION_SECRET"],
    fileNames: ["AUTOMATION_OS_SESSION_SECRET_FILE"],
    storedIdNames: ["AUTOMATION_OS_SESSION_SECRET_ID"],
    keychainServiceNames: ["AUTOMATION_OS_SESSION_KEYCHAIN_SERVICE"],
    defaultKeychainService: "Automation OS admin session"
  },
  private_ingress: {
    envNames: ["AUTOMATION_OS_PRIVATE_INGRESS_SECRET"],
    fileNames: ["AUTOMATION_OS_PRIVATE_INGRESS_SECRET_FILE"],
    storedIdNames: ["AUTOMATION_OS_PRIVATE_INGRESS_SECRET_ID"],
    keychainServiceNames: ["AUTOMATION_OS_PRIVATE_INGRESS_KEYCHAIN_SERVICE"],
    defaultKeychainService: "Automation OS private ingress"
  }
};

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function currentUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function readOwnerOnlyFile(pathValue: string): string {
  const path = textValue(pathValue);
  if (!path || !path.startsWith("/")) return "";
  try {
    const stat = lstatSync(path);
    const uid = currentUid();
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || (uid !== null && stat.uid !== uid)) return "";
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function keychainEnabled(env: NodeJS.ProcessEnv): boolean {
  if (env.AUTOMATION_OS_KEYCHAIN_ENABLED === "1") return true;
  if (env.AUTOMATION_OS_KEYCHAIN_ENABLED === "0" || env.NODE_TEST_CONTEXT === "1") return false;
  return process.platform === "darwin";
}

function readKeychainSecret(service: string, env: NodeJS.ProcessEnv, keychainRunner: KeychainRunner = spawnSync): string {
  if (!keychainEnabled(env) || !textValue(service)) return "";
  try {
    const result = keychainRunner("security", ["find-generic-password", "-s", textValue(service), "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3_000
    });
    return result.status === 0 ? textValue(result.stdout) : "";
  } catch {
    return "";
  }
}

function readSecret(kind: AuthSecretKind, env: NodeJS.ProcessEnv, keychainRunner?: KeychainRunner): SecretResolution {
  const config = SECRET_CONFIG[kind];
  for (const name of config.envNames) {
    const value = textValue(env[name]);
    if (value) return { value, source: "environment" };
  }
  for (const name of config.fileNames) {
    const value = readOwnerOnlyFile(textValue(env[name]));
    if (value) return { value, source: "file" };
  }
  for (const name of config.storedIdNames) {
    const id = textValue(env[name]);
    if (!id) continue;
    try {
      const value = textValue(readStoredSecret(id));
      if (value) return { value, source: "secret_store" };
    } catch {
      // A missing/unavailable secret store remains a fail-closed empty result.
    }
  }
  const service = textValue(env[config.keychainServiceNames[0]]) || config.defaultKeychainService;
  const value = readKeychainSecret(service, env, keychainRunner);
  if (value) return { value, source: "keychain" };
  return { value: "", source: "none" };
}

export function readServerSecret(kind: AuthSecretKind, env: NodeJS.ProcessEnv = process.env): string {
  return readSecret(kind, env).value;
}

export function readServerSecretStatus(kind: AuthSecretKind, env: NodeJS.ProcessEnv = process.env, keychainRunner?: KeychainRunner): { available: boolean; source: AuthSecretSource } {
  const result = readSecret(kind, env, keychainRunner);
  return { available: Boolean(result.value), source: result.source };
}

export function readServerAuthStatus(env: NodeJS.ProcessEnv = process.env): ServerAuthStatus {
  const session = readServerSecretStatus("session", env);
  const serviceIdentity = readServerSecretStatus("service_identity", env);
  const read = readServerSecretStatus("read", env);
  const write = readServerSecretStatus("write", env);
  const privateIngress = readServerSecretStatus("private_ingress", env);
  const required = env.AUTOMATION_OS_REQUIRE_API_TOKEN === "1"
    || (env.AUTOMATION_OS_REQUIRE_API_TOKEN !== "0" && !env.NODE_TEST_CONTEXT);
  return {
    required,
    sessionConfigured: session.available || serviceIdentity.available,
    privateIngressConfigured: privateIngress.available || env.AUTOMATION_OS_LOOPBACK_SESSION === "1",
    serviceIdentityConfigured: serviceIdentity.available,
    readTokenConfigured: read.available,
    writeTokenConfigured: write.available,
    tokenConfigured: session.available || serviceIdentity.available || read.available || write.available,
    sessionSource: session.available ? session.source : serviceIdentity.available ? "derived" : "none",
    privateIngressSource: privateIngress.source,
    serviceIdentitySource: serviceIdentity.source,
    readTokenSource: read.source,
    writeTokenSource: write.source
  };
}

export function readRequestToken(headers: IncomingHttpHeaders): string {
  const value = headers["x-automation-os-token"] ?? headers.authorization;
  const header = Array.isArray(value) ? value[0] : value;
  return textValue(header).replace(/^Bearer\s+/iu, "").trim();
}

function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of textValue(header).split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) result[name] = value;
  }
  return result;
}

function hmac(secret: string, value: string): Buffer {
  return createHmac("sha256", secret).update(value, "utf8").digest();
}

function signedSessionPayload(scope: Exclude<AuthScope, "unknown" | "unrestricted">, secret: string, nowMs = Date.now()): string {
  const expiresAt = Math.floor(nowMs / 1000) + AUTH_SESSION_MAX_AGE_SECONDS;
  const nonce = randomBytes(18).toString("base64url");
  const body = `v1.${scope}.${expiresAt}.${nonce}`;
  return `${body}.${hmac(secret, body).toString("base64url")}`;
}

function sessionScopeFromCookie(value: string, secret: string, nowMs = Date.now()): Exclude<AuthScope, "unknown" | "unrestricted"> | null {
  const parts = value.split(".");
  if (parts.length !== 5 || parts[0] !== "v1" || (parts[1] !== "read" && parts[1] !== "write")) return null;
  const expiresAt = Number(parts[2]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(nowMs / 1000)) return null;
  const body = parts.slice(0, 4).join(".");
  const expected = hmac(secret, body);
  const provided = Buffer.from(parts[4], "base64url");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  return parts[1];
}

export function readSessionScope(headers: IncomingHttpHeaders, env: NodeJS.ProcessEnv = process.env): Exclude<AuthScope, "unknown" | "unrestricted"> | null {
  const cookie = parseCookies(typeof headers.cookie === "string" ? headers.cookie : undefined)[AUTH_SESSION_COOKIE_NAME];
  if (!cookie) return null;
  const sessionSecret = readServerSecret("session", env) || readServerSecret("service_identity", env);
  if (!sessionSecret) return null;
  return sessionScopeFromCookie(cookie, sessionSecret);
}

function isAutomationTriggerPath(method: string | undefined, path: string | undefined): boolean {
  return method === "POST" && /^\/api\/v1\/companies\/[^/]+\/automations\/[^/]+\/trigger$/u.test(path || "");
}

export function readRequestAuth(request: { method?: string; path?: string; headers: IncomingHttpHeaders }, env: NodeJS.ProcessEnv = process.env): RequestAuth {
  const sessionScope = readSessionScope(request.headers, env);
  if (sessionScope) return { scope: sessionScope, method: "session_cookie", tokenPresented: false };
  const token = readRequestToken(request.headers);
  if (!token) return { scope: "unknown", method: "none", tokenPresented: false };
  const serviceIdentity = readServerSecret("service_identity", env);
  if (serviceIdentity && isAutomationTriggerPath(request.method, request.path) && secureTokenEqual(token, serviceIdentity)) {
    return { scope: "write", method: "service_identity", tokenPresented: true };
  }
  const writeToken = readServerSecret("write", env);
  if (writeToken && secureTokenEqual(token, writeToken)) return { scope: "write", method: "header_token", tokenPresented: true };
  const readToken = readServerSecret("read", env);
  if (readToken && ["GET", "HEAD"].includes(request.method || "") && secureTokenEqual(token, readToken)) {
    return { scope: "read", method: "header_token", tokenPresented: true };
  }
  return { scope: "unknown", method: "none", tokenPresented: true };
}

export function readWebSessionScope(env: NodeJS.ProcessEnv = process.env): Exclude<AuthScope, "unknown" | "unrestricted"> | null {
  const configured = textValue(env.AUTOMATION_OS_AUTH_SESSION_SCOPE).toLowerCase();
  if (configured === "read" || configured === "write") return configured;
  if (readServerSecret("write", env)) return "write";
  if (readServerSecret("read", env)) return "read";
  if (readServerSecret("session", env) || readServerSecret("service_identity", env)) return "write";
  return null;
}

function isLoopbackAddress(value: string | undefined): boolean {
  const normalized = textValue(value).replace(/^::ffff:/iu, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

export function canBootstrapSession(request: { headers: IncomingHttpHeaders; socket?: { remoteAddress?: string } }, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.AUTOMATION_OS_LOOPBACK_SESSION === "1" && isLoopbackAddress(request.socket?.remoteAddress)) return true;
  const expected = readServerSecret("private_ingress", env);
  const provided = request.headers["x-automation-os-private-ingress"];
  const header = Array.isArray(provided) ? provided[0] : provided;
  return Boolean(expected && header && secureTokenEqual(textValue(header), expected));
}

export function issueSessionCookie(scope: Exclude<AuthScope, "unknown" | "unrestricted">, env: NodeJS.ProcessEnv = process.env): string | null {
  const secret = readServerSecret("session", env) || readServerSecret("service_identity", env);
  if (!secret) return null;
  const secure = env.AUTOMATION_OS_AUTH_COOKIE_SECURE !== "0";
  return [
    `${AUTH_SESSION_COOKIE_NAME}=${signedSessionPayload(scope, secret)}`,
    `Max-Age=${AUTH_SESSION_MAX_AGE_SECONDS}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    ...(secure ? ["Secure"] : [])
  ].join("; ");
}

export function clearSessionCookie(env: NodeJS.ProcessEnv = process.env): string {
  const secure = env.AUTOMATION_OS_AUTH_COOKIE_SECURE !== "0";
  return [
    `${AUTH_SESSION_COOKIE_NAME}=`,
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    ...(secure ? ["Secure"] : [])
  ].join("; ");
}

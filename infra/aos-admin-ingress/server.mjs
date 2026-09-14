import http from "node:http";
import https from "node:https";
import { createHash, createHmac, createPublicKey, createVerify, randomBytes, timingSafeEqual } from "node:crypto";
import { URL } from "node:url";

const PROXY_SESSION_COOKIE = "aos_ingress_session";
const OIDC_STATE_COOKIE = "aos_ingress_oidc_state";
const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MIN_SESSION_TTL_SECONDS = 10 * 60;
const MAX_SESSION_TTL_SECONDS = 90 * 24 * 60 * 60;
const STATE_TTL_SECONDS = 10 * 60;
const DISCOVERY_TTL_MS = 5 * 60 * 1000;
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "connection",
  "content-length",
  "x-automation-os-private-ingress"
]);

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function required(name, value) {
  const normalized = text(value);
  if (!normalized) throw new Error(`missing_config:${name}`);
  return normalized;
}

function parseSessionTtl(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_SESSION_TTL_SECONDS || parsed > MAX_SESSION_TTL_SECONDS) {
    return DEFAULT_SESSION_TTL_SECONDS;
  }
  return parsed;
}

function parseHttpsUrl(name, value) {
  const raw = required(name, value);
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(`invalid_config:${name}`);
  }
  return parsed;
}

function parseUpstreamUrl(value) {
  const parsed = new URL(required("UPSTREAM_BASE_URL", value));
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("invalid_config:UPSTREAM_BASE_URL");
  }
  return parsed;
}

function decodeBase64Url(value) {
  return Buffer.from(value, "base64url");
}

function encodeBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function hmac(secret, value) {
  return createHmac("sha256", secret).update(value, "utf8").digest();
}

function signedValue(secret, payload) {
  const body = encodeBase64Url(JSON.stringify(payload));
  return `${body}.${encodeBase64Url(hmac(secret, body))}`;
}

function verifiedValue(secret, value) {
  const [body, signature] = text(value).split(".");
  if (!body || !signature) return null;
  const bodyBytes = decodeBase64Url(body);
  const provided = decodeBase64Url(signature);
  // Base64url has non-canonical spellings for values whose final sextet
  // contains unused bits. Reject those spellings so a cookie cannot be
  // altered while still decoding to the same HMAC bytes.
  if (encodeBase64Url(bodyBytes) !== body || encodeBase64Url(provided) !== signature) return null;
  const expected = hmac(secret, body);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  try {
    return JSON.parse(bodyBytes.toString("utf8"));
  } catch {
    return null;
  }
}

function cookieParts(header) {
  const result = new Map();
  for (const part of text(header).split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    result.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return result;
}

function cookieValue(header, name) {
  return cookieParts(header).get(name) || "";
}

function cookieHeader(name, value, options = {}) {
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly", `SameSite=${options.sameSite || "Lax"}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.secure !== false) parts.push("Secure");
  return parts.join("; ");
}

function clearCookieHeader(name, secure = true) {
  return cookieHeader(name, "", { maxAge: 0, secure });
}

function safeReturnTo(value) {
  const candidate = text(value) || "/";
  if (!candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\")) return "/";
  return candidate;
}

function parseAllowedEmails(value) {
  return new Set(text(value).split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean));
}

export function buildConfig(env = process.env) {
  const publicBaseUrl = parseHttpsUrl("PUBLIC_BASE_URL", env.PUBLIC_BASE_URL);
  const upstreamBaseUrl = parseUpstreamUrl(env.UPSTREAM_BASE_URL);
  const oidcIssuerUrl = parseHttpsUrl("OIDC_ISSUER_URL", env.OIDC_ISSUER_URL);
  const oidcAllowedEmails = parseAllowedEmails(env.OIDC_ALLOWED_EMAILS);
  if (oidcAllowedEmails.size === 0) throw new Error("missing_config:OIDC_ALLOWED_EMAILS");
  const proxySessionSecret = Buffer.from(required("PROXY_SESSION_SECRET", env.PROXY_SESSION_SECRET));
  const aosPrivateIngressSecret = required("AOS_PRIVATE_INGRESS_SECRET", env.AOS_PRIVATE_INGRESS_SECRET);
  if (proxySessionSecret.length < 32) throw new Error("invalid_config:PROXY_SESSION_SECRET");
  if (aosPrivateIngressSecret.length < 32) throw new Error("invalid_config:AOS_PRIVATE_INGRESS_SECRET");
  const clientId = required("OIDC_CLIENT_ID", env.OIDC_CLIENT_ID);
  const clientSecret = required("OIDC_CLIENT_SECRET", env.OIDC_CLIENT_SECRET);
  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid_config:PORT");
  return Object.freeze({
    host: text(env.HOST) || "0.0.0.0",
    port,
    publicBaseUrl: publicBaseUrl.toString().replace(/\/$/u, ""),
    upstreamBaseUrl,
    oidcIssuerUrl: oidcIssuerUrl.toString().replace(/\/$/u, ""),
    oidcClientId: clientId,
    oidcClientSecret: clientSecret,
    oidcAllowedEmails,
    proxySessionSecret,
    aosPrivateIngressSecret,
    secureCookies: env.COOKIE_SECURE !== "0",
    sessionTtlSeconds: parseSessionTtl(env.PROXY_SESSION_TTL_SECONDS)
  });
}

export function createSessionCookie(config, identity, now = Date.now()) {
  return signedValue(config.proxySessionSecret, {
    v: 1,
    sub: identity.sub,
    email: identity.email,
    exp: Math.floor(now / 1000) + config.sessionTtlSeconds
  });
}

export function readSession(config, header, now = Date.now()) {
  const payload = verifiedValue(config.proxySessionSecret, cookieValue(header, PROXY_SESSION_COOKIE));
  if (!payload || payload.v !== 1 || !text(payload.sub) || !text(payload.email)) return null;
  if (!Number.isSafeInteger(payload.exp) || payload.exp <= Math.floor(now / 1000)) return null;
  if (!config.oidcAllowedEmails.has(payload.email.toLowerCase())) return null;
  return { sub: payload.sub, email: payload.email.toLowerCase(), exp: payload.exp };
}

export function createStateCookie(config, state, verifier, nonce, returnTo, now = Date.now()) {
  return signedValue(config.proxySessionSecret, {
    v: 1,
    state,
    verifier,
    nonce,
    returnTo: safeReturnTo(returnTo),
    exp: Math.floor(now / 1000) + STATE_TTL_SECONDS
  });
}

export function readStateCookie(config, header, now = Date.now()) {
  const payload = verifiedValue(config.proxySessionSecret, cookieValue(header, OIDC_STATE_COOKIE));
  if (!payload || payload.v !== 1 || !text(payload.state) || !text(payload.verifier) || !text(payload.nonce)) return null;
  if (!Number.isSafeInteger(payload.exp) || payload.exp <= Math.floor(now / 1000)) return null;
  return payload;
}

export function sanitizeUpstreamHeaders(headers, aosSession) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(name.toLowerCase())) continue;
    if (value !== undefined) result[name] = value;
  }
  if (aosSession) result.cookie = `${AUTH_COOKIE_NAME}=${aosSession}`;
  return result;
}

const AUTH_COOKIE_NAME = "aos_session";

function buildUpstreamHeaders(req, config) {
  const aosSession = cookieValue(req.headers.cookie, AUTH_COOKIE_NAME);
  const headers = sanitizeUpstreamHeaders(req.headers, aosSession);
  headers.host = config.upstreamBaseUrl.host;
  headers["x-forwarded-host"] = req.headers.host || "";
  headers["x-forwarded-proto"] = "https";
  headers["x-automation-os-private-ingress"] = config.aosPrivateIngressSecret;
  return headers;
}

async function fetchJson(url, options, blocker, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(url, options);
  } catch {
    throw new Error(blocker);
  }
  if (!response.ok) throw new Error(blocker);
  try {
    return await response.json();
  } catch {
    throw new Error(blocker);
  }
}

function createDiscoveryClient(config, fetchImpl = fetch) {
  let cached = null;
  let cachedAt = 0;
  return async function discovery() {
    if (cached && Date.now() - cachedAt < DISCOVERY_TTL_MS) return cached;
    const endpoint = `${config.oidcIssuerUrl}/.well-known/openid-configuration`;
    let response;
    try {
      response = await fetchImpl(endpoint, { headers: { accept: "application/json" } });
    } catch {
      throw new Error("oidc_discovery_failed");
    }
    if (!response.ok) throw new Error("oidc_discovery_failed");
    const document = await response.json().catch(() => null);
    if (!document?.authorization_endpoint || !document?.token_endpoint || !document?.userinfo_endpoint || !document?.jwks_uri) {
      throw new Error("oidc_discovery_invalid");
    }
    cached = document;
    cachedAt = Date.now();
    return cached;
  };
}

function parseJwtPart(value, blocker) {
  try {
    return JSON.parse(decodeBase64Url(value).toString("utf8"));
  } catch {
    throw new Error(blocker);
  }
}

async function verifyIdToken(idToken, state, config, oidc, fetchImpl = fetch) {
  const parts = text(idToken).split(".");
  if (parts.length !== 3) throw new Error("oidc_id_token_invalid");
  const header = parseJwtPart(parts[0], "oidc_id_token_invalid");
  const claims = parseJwtPart(parts[1], "oidc_id_token_invalid");
  if (header.alg !== "RS256" || !text(header.kid)) throw new Error("oidc_id_token_alg_unsupported");
  const jwks = await fetchJson(oidc.jwks_uri, { headers: { accept: "application/json" } }, "oidc_jwks_failed", fetchImpl);
  const key = Array.isArray(jwks.keys) ? jwks.keys.find((candidate) => candidate.kid === header.kid && candidate.kty === "RSA") : null;
  if (!key) throw new Error("oidc_jwks_key_missing");
  let publicKey;
  try {
    publicKey = createPublicKey({ key, format: "jwk" });
  } catch {
    throw new Error("oidc_jwks_key_invalid");
  }
  const signature = decodeBase64Url(parts[2]);
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${parts[0]}.${parts[1]}`);
  verifier.end();
  if (!verifier.verify(publicKey, signature)) throw new Error("oidc_id_token_signature_invalid");
  const issuer = config.oidcIssuerUrl.replace(/\/$/u, "");
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== issuer || !audience.includes(config.oidcClientId) || claims.nonce !== state.nonce || !Number.isSafeInteger(claims.exp) || claims.exp <= now || (Number.isSafeInteger(claims.iat) && claims.iat > now + 60) || !text(claims.sub)) {
    throw new Error("oidc_id_token_claims_invalid");
  }
  return claims;
}

function randomVerifier() {
  return randomBytes(32).toString("base64url");
}

function pkceChallenge(verifier) {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

function redirect(res, location, cookies = []) {
  res.statusCode = 302;
  res.setHeader("Location", location);
  if (cookies.length > 0) res.setHeader("Set-Cookie", cookies);
  res.end();
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function isApiPath(pathname) {
  return pathname === "/api" || pathname.startsWith("/api/");
}

async function login(req, res, config, discovery) {
  const requestUrl = new URL(req.url || "/", `${config.publicBaseUrl}/`);
  const state = randomBytes(24).toString("base64url");
  const verifier = randomVerifier();
  const nonce = randomBytes(24).toString("base64url");
  const returnTo = safeReturnTo(requestUrl.searchParams.get("return_to"));
  const oidc = await discovery();
  const callback = `${config.publicBaseUrl}/auth/callback`;
  const authorization = new URL(oidc.authorization_endpoint);
  authorization.searchParams.set("client_id", config.oidcClientId);
  authorization.searchParams.set("redirect_uri", callback);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("scope", "openid email profile");
  authorization.searchParams.set("state", state);
  authorization.searchParams.set("nonce", nonce);
  authorization.searchParams.set("code_challenge", pkceChallenge(verifier));
  authorization.searchParams.set("code_challenge_method", "S256");
  redirect(res, authorization.toString(), [cookieHeader(OIDC_STATE_COOKIE, createStateCookie(config, state, verifier, nonce, returnTo), { sameSite: "Lax", secure: config.secureCookies, maxAge: STATE_TTL_SECONDS })]);
}

async function callback(req, res, config, discovery, fetchImpl = fetch) {
  const requestUrl = new URL(req.url || "/", `${config.publicBaseUrl}/`);
  const state = readStateCookie(config, req.headers.cookie);
  const code = text(requestUrl.searchParams.get("code"));
  if (!state || !code || state.state !== requestUrl.searchParams.get("state")) {
    json(res, 401, { ok: false, status: "blocked", exactBlocker: "oidc_state_mismatch" });
    return;
  }
  const oidc = await discovery();
  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: `${config.publicBaseUrl}/auth/callback`,
    client_id: config.oidcClientId,
    client_secret: config.oidcClientSecret,
    code_verifier: state.verifier
  });
  const token = await fetchJson(oidc.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: tokenBody }, "oidc_token_exchange_failed", fetchImpl);
  if (!text(token.access_token) || !text(token.id_token)) throw new Error("oidc_token_missing");
  const idClaims = await verifyIdToken(token.id_token, state, config, oidc, fetchImpl);
  const identity = await fetchJson(oidc.userinfo_endpoint, { headers: { authorization: `Bearer ${token.access_token}`, accept: "application/json" } }, "oidc_userinfo_failed", fetchImpl);
  const email = text(identity.email || idClaims.email).toLowerCase();
  const sub = text(identity.sub || idClaims.sub);
  const verified = identity.email_verified === true || idClaims.email_verified === true;
  if (!sub || !email || !verified || !config.oidcAllowedEmails.has(email)) {
    json(res, 403, { ok: false, status: "blocked", exactBlocker: "oidc_owner_allowlist_failed" });
    return;
  }
  const session = createSessionCookie(config, { sub, email });
  redirect(res, state.returnTo, [
    clearCookieHeader(OIDC_STATE_COOKIE, config.secureCookies),
    cookieHeader(PROXY_SESSION_COOKIE, session, { sameSite: "Lax", secure: config.secureCookies, maxAge: config.sessionTtlSeconds })
  ]);
}

function proxy(req, res, config, session) {
  const target = new URL(req.url || "/", config.upstreamBaseUrl);
  const transport = target.protocol === "https:" ? https : http;
  const upstream = transport.request(target, { method: req.method, headers: buildUpstreamHeaders(req, config), timeout: 15_000 }, (upstreamResponse) => {
    res.statusCode = upstreamResponse.statusCode || 502;
    const upstreamSetCookies = upstreamResponse.headers["set-cookie"];
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      if (name.toLowerCase() === "set-cookie") continue;
      if (value !== undefined) res.setHeader(name, value);
    }
    const refreshedProxyCookie = cookieHeader(PROXY_SESSION_COOKIE, createSessionCookie(config, session), {
      sameSite: "Lax",
      secure: config.secureCookies,
      maxAge: config.sessionTtlSeconds
    });
    const setCookies = [refreshedProxyCookie];
    if (Array.isArray(upstreamSetCookies)) setCookies.push(...upstreamSetCookies);
    else if (typeof upstreamSetCookies === "string") setCookies.push(upstreamSetCookies);
    res.setHeader("Set-Cookie", setCookies);
    upstreamResponse.pipe(res);
  });
  upstream.on("timeout", () => upstream.destroy(new Error("upstream_timeout")));
  upstream.on("error", () => {
    if (!res.headersSent) json(res, 502, { ok: false, status: "blocked", exactBlocker: "aos_upstream_unavailable" });
    else res.destroy();
  });
  req.pipe(upstream);
}

export function createIngressServer(config, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || fetch;
  const discovery = dependencies.discovery || createDiscoveryClient(config, fetchImpl);
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url || "/", config.publicBaseUrl).pathname;
    try {
      if (pathname === "/healthz" || pathname === "/readyz") {
        json(res, 200, { ok: true, service: "aos-admin-ingress", status: "ready" });
        return;
      }
      if (pathname === "/auth/login") {
        await login(req, res, config, discovery);
        return;
      }
      if (pathname === "/auth/callback") {
        await callback(req, res, config, discovery, fetchImpl);
        return;
      }
      if (pathname === "/auth/logout") {
        redirect(res, "/", [clearCookieHeader(PROXY_SESSION_COOKIE, config.secureCookies), clearCookieHeader(AUTH_COOKIE_NAME, config.secureCookies)]);
        return;
      }
      const session = readSession(config, req.headers.cookie);
      if (!session) {
        if (isApiPath(pathname)) {
          json(res, 401, { ok: false, status: "blocked", exactBlocker: "owner_sso_required" });
        } else {
          redirect(res, `/auth/login?return_to=${encodeURIComponent(safeReturnTo(pathname))}`);
        }
        return;
      }
      proxy(req, res, config, session);
    } catch (error) {
      const exactBlocker = error instanceof Error && /^([a-z0-9_]+:)?[a-z0-9_]+$/u.test(error.message) ? error.message : "ingress_internal_error";
      if (!res.headersSent) json(res, 502, { ok: false, status: "blocked", exactBlocker });
      else res.destroy();
    }
  });
  return server;
}

export function startFromEnvironment(env = process.env) {
  const config = buildConfig(env);
  const server = createIngressServer(config);
  server.listen(config.port, config.host, () => {
    process.stdout.write(JSON.stringify({ ok: true, service: "aos-admin-ingress", host: config.host, port: config.port, upstream_host: config.upstreamBaseUrl.hostname }) + "\n");
  });
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    startFromEnvironment();
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid_config";
    process.stderr.write(JSON.stringify({ ok: false, status: "blocked", exactBlocker: message }) + "\n");
    process.exitCode = 78;
  }
}

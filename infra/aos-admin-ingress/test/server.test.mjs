import test from "node:test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import http from "node:http";
import {
  buildConfig,
  createIngressServer,
  createSessionCookie,
  createStateCookie,
  readSession,
  sanitizeUpstreamHeaders
} from "../server.mjs";

function env(overrides = {}) {
  return {
    PUBLIC_BASE_URL: "https://admin.example.test",
    UPSTREAM_BASE_URL: "http://127.0.0.1:1",
    OIDC_ISSUER_URL: "https://accounts.example.test",
    OIDC_CLIENT_ID: "client-id",
    OIDC_CLIENT_SECRET: "client-secret",
    OIDC_ALLOWED_EMAILS: "owner@example.com",
    PROXY_SESSION_SECRET: "proxy-session-secret-012345678901234567890123",
    AOS_PRIVATE_INGRESS_SECRET: "aos-private-ingress-secret-012345678901234567890123",
    ...overrides
  };
}

test("buildConfig fails closed when an OIDC secret is missing", () => {
  assert.throws(() => buildConfig(env({ OIDC_CLIENT_SECRET: "" })), /missing_config:OIDC_CLIENT_SECRET/);
});

test("session cookies are signed, expiring, and allowlist-bound", () => {
  const config = buildConfig(env());
  const cookie = createSessionCookie(config, { sub: "owner-sub", email: "owner@example.com" });
  assert.equal(config.sessionTtlSeconds, 30 * 24 * 60 * 60);
  assert.ok(readSession(config, `aos_ingress_session=${cookie}`));
  assert.equal(readSession(config, `aos_ingress_session=${cookie.slice(0, -1)}x`), null);
  assert.equal(readSession(config, `aos_ingress_session=${createSessionCookie(config, { sub: "x", email: "other@example.com" })}`), null);
});

test("proxy rolls the ingress session without dropping the upstream session cookie", async () => {
  const upstream = http.createServer((_req, res) => {
    res.setHeader("Set-Cookie", "aos_session=refreshed-upstream; Path=/; HttpOnly; Secure");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const config = buildConfig(env({ UPSTREAM_BASE_URL: `http://127.0.0.1:${upstream.address().port}` }));
  const ingress = createIngressServer(config, { discovery: async () => ({}) });
  await new Promise((resolve) => ingress.listen(0, "127.0.0.1", resolve));
  const session = createSessionCookie(config, { sub: "owner-sub", email: "owner@example.com" });
  const response = await fetch(`http://127.0.0.1:${ingress.address().port}/api/auth/session`, {
    headers: { cookie: `aos_ingress_session=${session}` }
  });
  assert.equal(response.status, 200);
  const setCookies = response.headers.getSetCookie();
  assert.ok(setCookies.some((value) => value.startsWith("aos_ingress_session=") && value.includes("Max-Age=2592000")));
  assert.ok(setCookies.some((value) => value.startsWith("aos_session=refreshed-upstream")));
  await new Promise((resolve) => ingress.close(resolve));
  await new Promise((resolve) => upstream.close(resolve));
});

test("upstream headers strip spoofable credentials and proxy cookies", () => {
  const sanitized = sanitizeUpstreamHeaders({
    host: "public.example",
    authorization: "Bearer should-not-forward",
    cookie: "aos_ingress_session=proxy; aos_session=keep",
    "x-automation-os-private-ingress": "spoofed",
    accept: "application/json"
  }, "aos-session-value");
  assert.equal(sanitized.authorization, undefined);
  assert.equal(sanitized["x-automation-os-private-ingress"], undefined);
  assert.equal(sanitized.cookie, "aos_session=aos-session-value");
  assert.equal(sanitized.accept, "application/json");
});

test("authenticated requests inject only the AOS private-ingress proof", async () => {
  const upstream = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      privateIngress: req.headers["x-automation-os-private-ingress"] || null,
      cookie: req.headers.cookie || null,
      authorization: req.headers.authorization || null
    }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;
  const config = buildConfig(env({ UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}` }));
  const ingress = createIngressServer(config, { discovery: async () => ({}) });
  await new Promise((resolve) => ingress.listen(0, "127.0.0.1", resolve));
  const ingressPort = ingress.address().port;
  const session = createSessionCookie(config, { sub: "owner-sub", email: "owner@example.com" });
  const response = await fetch(`http://127.0.0.1:${ingressPort}/api/auth/capability`, {
    headers: {
      cookie: `aos_ingress_session=${session}; aos_session=browser-session`,
      authorization: "Bearer inbound-token",
      "x-automation-os-private-ingress": "spoofed"
    }
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    privateIngress: config.aosPrivateIngressSecret,
    cookie: "aos_session=browser-session",
    authorization: null
  });
  await new Promise((resolve) => ingress.close(resolve));
  await new Promise((resolve) => upstream.close(resolve));
});

test("unauthenticated API access fails closed without touching upstream", async () => {
  const ingress = createIngressServer(buildConfig(env()), { discovery: async () => ({}) });
  await new Promise((resolve) => ingress.listen(0, "127.0.0.1", resolve));
  const response = await fetch(`http://127.0.0.1:${ingress.address().port}/api/mvp/state`);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, status: "blocked", exactBlocker: "owner_sso_required" });
  await new Promise((resolve) => ingress.close(resolve));
});

test("OIDC callback validates state, PKCE-bound ID token, nonce, signature, and owner email", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  jwk.kid = "test-key";
  const oidc = {
    authorization_endpoint: "https://idp.example.test/authorize",
    token_endpoint: "https://idp.example.test/token",
    userinfo_endpoint: "https://idp.example.test/userinfo",
    jwks_uri: "https://idp.example.test/jwks"
  };
  const config = buildConfig(env({ OIDC_ISSUER_URL: "https://idp.example.test" }));
  let expectedNonce = "";
  const fetchImpl = async (url) => {
    if (url.endsWith("/token")) {
      const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-key" })).toString("base64url");
      const claims = { iss: "https://idp.example.test", aud: config.oidcClientId, sub: "owner-sub", email: "owner@example.com", email_verified: true, nonce: expectedNonce, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300 };
      const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
      const signer = createSign("RSA-SHA256");
      signer.update(`${header}.${payload}`);
      signer.end();
      return new Response(JSON.stringify({ access_token: "access", id_token: `${header}.${payload}.${signer.sign(privateKey).toString("base64url")}` }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/jwks")) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { "content-type": "application/json" } });
    if (url.endsWith("/userinfo")) return new Response(JSON.stringify({ sub: "owner-sub", email: "owner@example.com", email_verified: true }), { status: 200, headers: { "content-type": "application/json" } });
    if (url.endsWith("/.well-known/openid-configuration")) return new Response(JSON.stringify(oidc), { status: 200, headers: { "content-type": "application/json" } });
    throw new Error(`unexpected_test_fetch:${url}`);
  };
  const ingress = createIngressServer(config, { fetchImpl });
  await new Promise((resolve) => ingress.listen(0, "127.0.0.1", resolve));
  const port = ingress.address().port;
  const loginResponse = await fetch(`http://127.0.0.1:${port}/auth/login?return_to=%2Fadmin`, { redirect: "manual" });
  assert.equal(loginResponse.status, 302);
  const stateCookie = loginResponse.headers.getSetCookie().find((value) => value.startsWith("aos_ingress_oidc_state="));
  expectedNonce = JSON.parse(Buffer.from(stateCookie.split(";", 1)[0].split("=", 2)[1].split(".")[0], "base64url").toString("utf8")).nonce;
  const location = new URL(loginResponse.headers.get("location"));
  const callbackResponse = await fetch(`http://127.0.0.1:${port}/auth/callback?code=code&state=${encodeURIComponent(location.searchParams.get("state"))}`, { headers: { cookie: stateCookie }, redirect: "manual" });
  assert.equal(callbackResponse.status, 302);
  assert.ok(callbackResponse.headers.getSetCookie().some((value) => value.startsWith("aos_ingress_session=")));
  await new Promise((resolve) => ingress.close(resolve));
});

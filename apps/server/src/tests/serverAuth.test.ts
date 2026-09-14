import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  canBootstrapSession,
  issueSessionCookie,
  isLoopbackNoEffectTriggerRequest,
  isLoopbackPortableWorkerRequest,
  readRequestAuth,
  readServerAuthStatus,
  readServerSecret,
  readServerSecretStatus,
  readSessionScope
} from "../security/serverAuth.js";

const keychainDisabled = { AUTOMATION_OS_KEYCHAIN_ENABLED: "0" } as NodeJS.ProcessEnv;

test("server auth resolves credentials from server-side environment or owner-only files", () => {
  const root = mkdtempSync(join(tmpdir(), "automation-os-server-auth-"));
  const readPath = join(root, "read-token");
  writeFileSync(readPath, "read-file-sentinel\n", { mode: 0o600 });
  chmodSync(readPath, 0o600);

  const env = {
    ...keychainDisabled,
    AUTOMATION_OS_SERVICE_IDENTITY_TOKEN: "service-identity-sentinel",
    AUTOMATION_OS_READ_TOKEN_FILE: readPath,
    AUTOMATION_OS_WRITE_TOKEN: "write-server-sentinel"
  } as NodeJS.ProcessEnv;

  assert.equal(readServerSecret("service_identity", env), "service-identity-sentinel");
  assert.equal(readServerSecret("read", env), "read-file-sentinel");
  assert.equal(readServerSecretStatus("write", env).source, "environment");
  const status = readServerAuthStatus(env);
  assert.equal(status.serviceIdentityConfigured, true);
  assert.equal(status.readTokenConfigured, true);
  assert.equal(status.writeTokenConfigured, true);
  assert.doesNotMatch(JSON.stringify(status), /sentinel/iu);
});

test("session bootstrap requires private ingress and issues a signed HttpOnly Secure cookie without a token", () => {
  const env = {
    ...keychainDisabled,
    AUTOMATION_OS_REQUIRE_API_TOKEN: "1",
    AUTOMATION_OS_SESSION_SECRET: "session-signing-sentinel",
    AUTOMATION_OS_PRIVATE_INGRESS_SECRET: "private-ingress-sentinel",
    AUTOMATION_OS_AUTH_COOKIE_SECURE: "1"
  } as NodeJS.ProcessEnv;
  const request = {
    headers: { "x-automation-os-private-ingress": "private-ingress-sentinel" },
    socket: { remoteAddress: "10.0.0.5" }
  };
  assert.equal(canBootstrapSession(request, env), true);
  const cookie = issueSessionCookie("write", env);
  assert.ok(cookie);
  assert.match(cookie, /HttpOnly/u);
  assert.match(cookie, /Secure/u);
  assert.match(cookie, /SameSite=Strict/u);
  assert.doesNotMatch(cookie, /session-signing-sentinel|private-ingress-sentinel/iu);

  const headers = { cookie: cookie!.split(";", 1)[0] };
  assert.equal(readSessionScope(headers, env), "write");
  assert.deepEqual(readRequestAuth({ method: "POST", path: "/api/mvp/approvals", headers }, env), {
    scope: "write",
    method: "session_cookie",
    tokenPresented: false
  });
  assert.equal(canBootstrapSession({ headers: {}, socket: { remoteAddress: "10.0.0.5" } }, env), false);
});

test("session cookie defaults to a rolling 30-day lifetime and accepts a bounded override", () => {
  const baseEnv = {
    ...keychainDisabled,
    AUTOMATION_OS_REQUIRE_API_TOKEN: "1",
    AUTOMATION_OS_SESSION_SECRET: "session-signing-sentinel",
    AUTOMATION_OS_AUTH_COOKIE_SECURE: "1"
  } as NodeJS.ProcessEnv;
  const cookie = issueSessionCookie("write", baseEnv);
  assert.ok(cookie);
  assert.match(cookie!, /Max-Age=2592000/u);
  const override = issueSessionCookie("write", { ...baseEnv, AUTOMATION_OS_AUTH_SESSION_TTL_SECONDS: "3600" });
  assert.ok(override);
  assert.match(override!, /Max-Age=3600/u);
  const invalid = issueSessionCookie("write", { ...baseEnv, AUTOMATION_OS_AUTH_SESSION_TTL_SECONDS: "1" });
  assert.ok(invalid);
  assert.match(invalid!, /Max-Age=2592000/u);
});

test("loopback recovery session bootstrap is scoped to localhost and does not expose the secret", () => {
  const env = {
    ...keychainDisabled,
    AUTOMATION_OS_REQUIRE_API_TOKEN: "1",
    AUTOMATION_OS_LOOPBACK_SESSION: "1",
    AUTOMATION_OS_AUTH_COOKIE_SECURE: "0",
    AUTOMATION_OS_SESSION_SECRET: "loopback-session-sentinel",
    AUTOMATION_OS_AUTH_SESSION_SCOPE: "write"
  } as NodeJS.ProcessEnv;
  assert.equal(canBootstrapSession({ headers: {}, socket: { remoteAddress: "127.0.0.1" } }, env), true);
  assert.equal(canBootstrapSession({ headers: {}, socket: { remoteAddress: "10.0.0.5" } }, env), false);
  const cookie = issueSessionCookie("write", env);
  assert.ok(cookie);
  assert.doesNotMatch(cookie!, /loopback-session-sentinel/iu);
  assert.doesNotMatch(cookie!, /Secure/iu);
  assert.equal(readSessionScope({ cookie: cookie!.split(";", 1)[0] }, env), "write");
});

test("expired or tampered management sessions lose write access without affecting the live session", (t) => {
  let now = Date.parse("2026-09-06T00:00:00Z");
  t.mock.method(Date, "now", () => now);
  const env = {
    ...keychainDisabled,
    AUTOMATION_OS_REQUIRE_API_TOKEN: "1",
    AUTOMATION_OS_SESSION_SECRET: "isolated-expiry-sentinel",
    AUTOMATION_OS_AUTH_SESSION_TTL_SECONDS: "3600",
    AUTOMATION_OS_AUTH_COOKIE_SECURE: "1"
  } as NodeJS.ProcessEnv;
  const issued = issueSessionCookie("write", env);
  assert.ok(issued);
  const headers = { cookie: issued!.split(";", 1)[0] };
  assert.equal(readSessionScope(headers, env), "write");
  const originalScope = readRequestAuth({ method: "POST", path: "/api/mvp/approvals", headers }, env).scope;
  assert.equal(originalScope, "write");
  const tampered = { cookie: headers.cookie.replace("v1.write.", "v1.read.") };
  assert.equal(readSessionScope(tampered, env), null);
  now += 3600_000;
  assert.equal(readSessionScope(headers, env), null);
  assert.equal(readRequestAuth({ method: "POST", path: "/api/mvp/approvals", headers }, env).scope, "unknown");
  assert.equal(readRequestAuth({ method: "POST", path: "/api/mvp/approvals", headers: {} }, env).scope, "unknown");
});

test("loopback portable worker auth is limited to claim heartbeat and receipt", () => {
  const env = {
    ...keychainDisabled,
    AUTOMATION_OS_LOOPBACK_SESSION: "1"
  } as NodeJS.ProcessEnv;
  const headers = { "x-automation-os-local-worker": "1" };
  const request = { method: "POST", path: "/api/portable-worker/claim", headers, socket: { remoteAddress: "127.0.0.1" } };
  assert.equal(isLoopbackPortableWorkerRequest(request, env), true);
  assert.equal(isLoopbackPortableWorkerRequest({ ...request, path: "/api/portable-worker/run-a/receipt" }, env), true);
  assert.equal(isLoopbackPortableWorkerRequest({ ...request, path: "/api/portable-worker/heartbeat" }, env), true);
  assert.equal(isLoopbackPortableWorkerRequest({ ...request, path: "/api/mvp/state" }, env), false);
  assert.equal(isLoopbackPortableWorkerRequest({ ...request, headers: {} }, env), false);
  assert.equal(isLoopbackPortableWorkerRequest({ ...request, socket: { remoteAddress: "10.0.0.5" } }, env), false);
  assert.equal(isLoopbackPortableWorkerRequest({ ...request, method: "GET" }, env), false);
});

test("loopback no-effect trigger exception is limited to the official trigger shape", () => {
  const env = {
    ...keychainDisabled,
    AUTOMATION_OS_LOOPBACK_SESSION: "1"
  } as NodeJS.ProcessEnv;
  const request = {
    method: "POST",
    path: "/api/v1/companies/company-a/automations/automation-a/trigger",
    headers: { "x-automation-os-local-no-effect": "1" },
    socket: { remoteAddress: "127.0.0.1" },
    body: { execution_mode: "preflight_no_effect", external_action_allowed: false }
  };
  assert.equal(isLoopbackNoEffectTriggerRequest({ ...request, body: undefined }, env), true);
  assert.equal(isLoopbackNoEffectTriggerRequest(request, env), true);
  assert.equal(isLoopbackNoEffectTriggerRequest({ ...request, body: { execution_mode: "live", external_action_allowed: true } }, env), false);
  assert.equal(isLoopbackNoEffectTriggerRequest({ ...request, headers: {} }, env), false);
  assert.equal(isLoopbackNoEffectTriggerRequest({ ...request, path: "/api/mvp/approvals" }, env), false);
  assert.equal(isLoopbackNoEffectTriggerRequest({ ...request, socket: { remoteAddress: "10.0.0.5" } }, env), false);
});

test("automation-3 service identity is accepted only by the trigger route", () => {
  const env = {
    ...keychainDisabled,
    AUTOMATION_OS_SERVICE_IDENTITY_TOKEN: "automation-3-service-sentinel"
  } as NodeJS.ProcessEnv;
  const headers = { authorization: "Bearer automation-3-service-sentinel" };
  assert.deepEqual(readRequestAuth({ method: "POST", path: "/api/v1/companies/company-a/automations/automation-a/trigger", headers }, env), {
    scope: "write",
    method: "service_identity",
    tokenPresented: true
  });
  assert.equal(readRequestAuth({ method: "POST", path: "/api/mvp/approvals", headers }, env).scope, "unknown");
  assert.doesNotMatch(JSON.stringify(readServerAuthStatus(env)), /automation-3-service-sentinel/iu);
});

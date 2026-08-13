import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  canBootstrapSession,
  issueSessionCookie,
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

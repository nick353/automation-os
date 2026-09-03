import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isChatgptAccountAuthenticated,
  isCompletedCodexDeviceAuth,
  resolveManagedLoginReadback,
  shouldReissueCodexDeviceAuth
} from "../codex/authRecovery.js";

const managedLogin = {
  companyId: "company-1",
  login: {
    loginId: "login-stale",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "STALE-CODE"
  },
  startedAt: "2026-08-26T00:00:00.000Z"
};

test("device auth reissue is explicit and never restarts a terminal login", () => {
  assert.equal(shouldReissueCodexDeviceAuth({ status: "pending" }, false), false);
  assert.equal(shouldReissueCodexDeviceAuth({ status: "pending" }, true), true);
  assert.equal(shouldReissueCodexDeviceAuth({ status: "blocked" }, true), true);
  assert.equal(shouldReissueCodexDeviceAuth({ status: "verified" }, true), false);
  assert.equal(shouldReissueCodexDeviceAuth({ status: "already_authenticated" }, true), false);
  assert.equal(shouldReissueCodexDeviceAuth({ status: "not_started" }, true), false);
});

test("a populated ChatGPT account remains authenticated when requiresOpenaiAuth is true", () => {
  const authenticatedAccount = {
    accountPresent: true,
    accountType: "chatgpt",
    planType: "pro",
    requiresOpenaiAuth: true
  };
  assert.equal(isChatgptAccountAuthenticated(authenticatedAccount), true);
  assert.equal(isChatgptAccountAuthenticated({
    accountPresent: false,
    accountType: null
  }), false);
  assert.equal(isChatgptAccountAuthenticated({
    accountPresent: true,
    accountType: "apiKey"
  }), false);
});

test("device auth verification requires the ChatGPT account and both success notifications", () => {
  const account = { accountPresent: true, accountType: "chatgpt" };
  const completed = {
    loginCompletion: { success: true },
    accountUpdated: { authMode: "chatgpt" }
  };
  assert.equal(isCompletedCodexDeviceAuth(account, completed), true);
  assert.equal(isCompletedCodexDeviceAuth(account, {
    ...completed,
    loginCompletion: { success: false }
  }), false);
  assert.equal(isCompletedCodexDeviceAuth(account, {
    ...completed,
    accountUpdated: { authMode: null }
  }), false);
});

test("authenticated account without same-connection events ends stale device auth", () => {
  const readback = resolveManagedLoginReadback(
    managedLogin,
    { accountPresent: true, accountType: "chatgpt", planType: "pro", requiresOpenaiAuth: true },
    { loginCompletion: null, accountUpdated: null }
  );

  assert.equal(readback.status, "already_authenticated");
  assert.equal(readback.loginId, null);
  assert.equal(readback.verificationUrl, null);
  assert.equal(readback.userCode, null);
  assert.equal(readback.startedAt, null);
  assert.equal(readback.completionObserved, false);
  assert.equal(readback.accountUpdatedObserved, false);
  assert.equal(readback.exactBlocker, null);

  const partialEvents = resolveManagedLoginReadback(
    managedLogin,
    { accountPresent: true, accountType: "chatgpt", planType: "pro", requiresOpenaiAuth: true },
    {
      loginCompletion: { loginId: "login-stale", success: true, error: null, capturedAt: "2026-08-26T00:01:00.000Z" },
      accountUpdated: null
    }
  );
  assert.equal(partialEvents.status, "already_authenticated");
  assert.equal(partialEvents.completionObserved, true);
  assert.equal(partialEvents.accountUpdatedObserved, false);
});

test("authenticated account with both same-connection events remains verified", () => {
  const readback = resolveManagedLoginReadback(
    managedLogin,
    { accountPresent: true, accountType: "chatgpt", planType: "pro", requiresOpenaiAuth: true },
    {
      loginCompletion: { loginId: "login-stale", success: true, error: null, capturedAt: "2026-08-26T00:01:00.000Z" },
      accountUpdated: { authMode: "chatgpt", planType: "pro", capturedAt: "2026-08-26T00:01:01.000Z" }
    }
  );

  assert.equal(readback.status, "verified");
  assert.equal(readback.loginId, null);
  assert.equal(readback.verificationUrl, null);
  assert.equal(readback.userCode, null);
  assert.equal(readback.startedAt, null);
  assert.equal(readback.completionObserved, true);
  assert.equal(readback.accountUpdatedObserved, true);
});

test("unauthenticated account preserves pending device code behavior", () => {
  const readback = resolveManagedLoginReadback(
    managedLogin,
    { accountPresent: false, accountType: null, planType: null, requiresOpenaiAuth: true },
    { loginCompletion: null, accountUpdated: null }
  );

  assert.equal(readback.status, "pending");
  assert.equal(readback.loginId, managedLogin.login.loginId);
  assert.equal(readback.verificationUrl, managedLogin.login.verificationUrl);
  assert.equal(readback.userCode, managedLogin.login.userCode);
  assert.equal(readback.exactBlocker, "codex_device_code_entry_required");
});

test("managed login read failure remains blocked", () => {
  const readback = resolveManagedLoginReadback(
    managedLogin,
    null,
    null,
    "codex_device_auth_connection_failed"
  );

  assert.equal(readback.status, "blocked");
  assert.equal(readback.account, null);
  assert.equal(readback.exactBlocker, "codex_device_auth_connection_failed");
  assert.equal(readback.loginId, null);
  assert.equal(readback.verificationUrl, null);
  assert.equal(readback.userCode, null);
  assert.equal(readback.startedAt, null);
});

test("rejected device auth clears the stale code before readback", () => {
  const readback = resolveManagedLoginReadback(
    managedLogin,
    { accountPresent: false, accountType: null, planType: null, requiresOpenaiAuth: true },
    {
      loginCompletion: { loginId: "login-stale", success: false, error: "rejected", capturedAt: "2026-08-26T00:02:00.000Z" },
      accountUpdated: null
    }
  );

  assert.equal(readback.status, "blocked");
  assert.equal(readback.exactBlocker, "codex_device_auth_failed");
  assert.equal(readback.loginId, null);
  assert.equal(readback.verificationUrl, null);
  assert.equal(readback.userCode, null);
  assert.equal(readback.startedAt, null);
});

import { CodexAppServerClient, type CodexAppServerAccountReadback, type CodexAppServerDeviceLogin } from "./appServerClient.js";
import { getCodexAppServerConnectionReadback } from "./appServerConnection.js";

type ManagedDeviceLogin = {
  companyId: string;
  client: CodexAppServerClient;
  login: CodexAppServerDeviceLogin;
  startedAt: string;
};

type ManagedLoginMetadata = Pick<ManagedDeviceLogin, "companyId" | "login" | "startedAt">;
type AuthEventReadback = ReturnType<CodexAppServerClient["getAuthEventReadback"]>;

export type CodexDeviceAuthReadback = {
  status: "not_started" | "pending" | "verified" | "blocked" | "already_authenticated";
  companyId: string | null;
  loginId: string | null;
  verificationUrl: string | null;
  userCode: string | null;
  startedAt: string | null;
  account: CodexAppServerAccountReadback | null;
  completionObserved: boolean;
  accountUpdatedObserved: boolean;
  exactBlocker: string | null;
  externalActionExecuted: false;
  secretMaterialIncluded: false;
};

let managedLogin: ManagedDeviceLogin | null = null;

export type CodexDeviceAuthStartOptions = {
  restart?: boolean;
};

export function shouldReissueCodexDeviceAuth(
  readback: Pick<CodexDeviceAuthReadback, "status">,
  restart: boolean
): boolean {
  return restart && (readback.status === "pending" || readback.status === "blocked");
}

export function isChatgptAccountAuthenticated(
  account: Pick<CodexAppServerAccountReadback, "accountPresent" | "accountType"> | null
): boolean {
  return Boolean(account?.accountPresent && account.accountType === "chatgpt");
}

export function isCompletedCodexDeviceAuth(
  account: Pick<CodexAppServerAccountReadback, "accountPresent" | "accountType"> | null,
  events: {
    loginCompletion: { success: boolean } | null;
    accountUpdated: { authMode: string | null } | null;
  } | null
): boolean {
  return Boolean(
    isChatgptAccountAuthenticated(account)
    && events?.loginCompletion?.success === true
    && events.accountUpdated?.authMode === "chatgpt"
  );
}

export async function startCodexDeviceAuth(
  companyId: string,
  options: CodexDeviceAuthStartOptions = {}
): Promise<CodexDeviceAuthReadback> {
  const normalizedCompanyId = requireCompanyId(companyId);
  const connection = getCodexAppServerConnectionReadback();
  if (connection.mode !== "remote_websocket") throw new Error("codex_app_server_remote_required_for_auth");
  if (connection.exact_blocker) throw new Error(connection.exact_blocker);
  if (managedLogin && managedLogin.companyId !== normalizedCompanyId) throw new Error("codex_device_auth_company_scope_conflict");
  if (managedLogin) {
    const current = await readManagedLogin(managedLogin);
    if (!shouldReissueCodexDeviceAuth(current, options.restart === true)) return current;
    managedLogin.client.close();
    managedLogin = null;
  }

  const client = new CodexAppServerClient({ timeoutMs: 120_000 });
  try {
    const account = await client.readAccount();
    if (isChatgptAccountAuthenticated(account)) {
      client.close();
      return {
        status: "already_authenticated",
        companyId: normalizedCompanyId,
        loginId: null,
        verificationUrl: null,
        userCode: null,
        startedAt: null,
        account,
        completionObserved: false,
        accountUpdatedObserved: false,
        exactBlocker: null,
        externalActionExecuted: false,
        secretMaterialIncluded: false
      };
    }
    const login = await client.startDeviceCodeLogin();
    managedLogin = { companyId: normalizedCompanyId, client, login, startedAt: new Date().toISOString() };
    return readManagedLogin(managedLogin);
  } catch (error) {
    client.close();
    throw error;
  }
}

export async function readCodexDeviceAuth(companyId: string): Promise<CodexDeviceAuthReadback> {
  const normalizedCompanyId = requireCompanyId(companyId);
  if (!managedLogin) return readPersistedRemoteAccount(normalizedCompanyId);
  if (managedLogin.companyId !== normalizedCompanyId) throw new Error("codex_device_auth_company_scope_conflict");
  return readManagedLogin(managedLogin);
}

/**
 * Device login state is owned by the remote Codex App Server, not by this
 * web process.  After an AOS restart there is no in-memory ManagedDeviceLogin
 * to inspect, so use the official account/readback before reporting
 * `not_started`.  This is read-only and never exposes tokens or device codes.
 */
async function readPersistedRemoteAccount(companyId: string): Promise<CodexDeviceAuthReadback> {
  const connection = getCodexAppServerConnectionReadback();
  if (connection.mode !== "remote_websocket") {
    return emptyReadback(companyId, "codex_app_server_remote_required_for_auth");
  }
  if (connection.exact_blocker) return emptyReadback(companyId, connection.exact_blocker);

  const client = new CodexAppServerClient({ timeoutMs: 30_000 });
  try {
    const account = await client.readAccount();
    if (isChatgptAccountAuthenticated(account)) {
      return {
        status: "already_authenticated",
        companyId,
        loginId: null,
        verificationUrl: null,
        userCode: null,
        startedAt: null,
        account,
        completionObserved: false,
        accountUpdatedObserved: false,
        exactBlocker: null,
        externalActionExecuted: false,
        secretMaterialIncluded: false
      };
    }
    return emptyReadback(companyId, "codex_device_auth_not_started", account);
  } catch {
    return emptyReadback(companyId, "codex_device_auth_connection_failed");
  } finally {
    client.close();
  }
}

function emptyReadback(
  companyId: string,
  exactBlocker: string,
  account: CodexAppServerAccountReadback | null = null
): CodexDeviceAuthReadback {
  return {
    status: exactBlocker === "codex_device_auth_not_started" ? "not_started" : "blocked",
    companyId,
    loginId: null,
    verificationUrl: null,
    userCode: null,
    startedAt: null,
    account,
    completionObserved: false,
    accountUpdatedObserved: false,
    exactBlocker,
    externalActionExecuted: false,
    secretMaterialIncluded: false
  };
}

async function readManagedLogin(state: ManagedDeviceLogin): Promise<CodexDeviceAuthReadback> {
  let account: CodexAppServerAccountReadback;
  try {
    account = await state.client.readAccount();
  } catch {
    return resolveManagedLoginReadback(state, null, null, "codex_device_auth_connection_failed");
  }
  const events = state.client.getAuthEventReadback();
  return resolveManagedLoginReadback(state, account, events);
}

export function resolveManagedLoginReadback(
  state: ManagedLoginMetadata,
  account: CodexAppServerAccountReadback | null,
  events: AuthEventReadback | null,
  exactBlocker: string | null = null
): CodexDeviceAuthReadback {
  if (exactBlocker) return clearDeviceCode(baseReadback(state, "blocked", account, events, exactBlocker));
  // `requiresOpenaiAuth` may remain true even when account/read returns a
  // populated ChatGPT account. Completion is therefore proven by the account
  // plus the two login notifications, not by negating that capability flag.
  if (isCompletedCodexDeviceAuth(account, events)) {
    return clearDeviceCode(baseReadback(state, "verified", account, events, null));
  }
  if (isChatgptAccountAuthenticated(account) && account) {
    return alreadyAuthenticatedReadback(state, account, events);
  }
  if (events?.loginCompletion?.success === false) {
    // A rejected device code is terminal for this login attempt. Do not keep
    // exposing it as if it were still usable; the caller must explicitly
    // start a fresh attempt after the human-visible failure is understood.
    return clearDeviceCode(baseReadback(state, "blocked", account, events, "codex_device_auth_failed"));
  }
  return baseReadback(state, "pending", account, events, "codex_device_code_entry_required");
}

function alreadyAuthenticatedReadback(
  state: ManagedLoginMetadata,
  account: CodexAppServerAccountReadback,
  events: AuthEventReadback | null
): CodexDeviceAuthReadback {
  return {
    status: "already_authenticated",
    companyId: state.companyId,
    loginId: null,
    verificationUrl: null,
    userCode: null,
    startedAt: null,
    account,
    completionObserved: Boolean(events?.loginCompletion),
    accountUpdatedObserved: events?.accountUpdated?.authMode === "chatgpt",
    exactBlocker: null,
    externalActionExecuted: false,
    secretMaterialIncluded: false
  };
}

function baseReadback(
  state: ManagedLoginMetadata,
  status: CodexDeviceAuthReadback["status"],
  account: CodexAppServerAccountReadback | null,
  events: ReturnType<CodexAppServerClient["getAuthEventReadback"]> | null,
  exactBlocker: string | null
): CodexDeviceAuthReadback {
  return {
    status,
    companyId: state.companyId,
    loginId: state.login.loginId,
    verificationUrl: state.login.verificationUrl,
    userCode: state.login.userCode,
    startedAt: state.startedAt,
    account,
    completionObserved: Boolean(events?.loginCompletion),
    accountUpdatedObserved: events?.accountUpdated?.authMode === "chatgpt",
    exactBlocker,
    externalActionExecuted: false,
    secretMaterialIncluded: false
  };
}

function clearDeviceCode(readback: CodexDeviceAuthReadback): CodexDeviceAuthReadback {
  return {
    ...readback,
    loginId: null,
    verificationUrl: null,
    userCode: null,
    startedAt: null
  };
}

function requireCompanyId(value: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error("company_id_required");
  return normalized;
}

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getCodexAppServerConnectionReadback,
  resolveCodexAppServerConnection
} from "../codex/appServerConnection.js";

test("Codex App Server defaults to local stdio and keeps the fallback explicit", () => {
  const connection = resolveCodexAppServerConnection({}, {});
  assert.deepEqual(connection, { mode: "local_stdio", endpoint: "stdio://" });
  assert.deepEqual(getCodexAppServerConnectionReadback({}, {}), {
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
  });
});

test("remote connection readback is safe and never returns the bearer token", () => {
  const readback = getCodexAppServerConnectionReadback({
    remoteUrl: "wss://codex.example.test/app-server?token=must-not-be-accepted",
    remoteToken: "unit-test-token"
  }, {});
  assert.equal(readback.mode, "remote_websocket");
  assert.equal(readback.exact_blocker, "codex_app_server_remote_url_invalid");
  assert.equal(readback.transport_support, "experimental_remote_websocket");
  assert.equal(readback.production_remote_cutover_allowed, false);
  assert.equal(readback.production_promotion_blocker, "codex_app_server_remote_url_invalid");
  assert.equal(readback.endpoint, "wss://codex.example.test/app-server");
  assert.doesNotMatch(JSON.stringify(readback), /unit-test-token|must-not-be-accepted/u);
});

test("remote connection requires TLS for non-loopback hosts", () => {
  const readback = getCodexAppServerConnectionReadback({
    remoteUrl: "ws://codex.example.test:4500",
    remoteToken: "unit-test-token"
  }, {});
  assert.equal(readback.exact_blocker, "codex_app_server_remote_tls_required");
  assert.equal(readback.tls_required, true);
  assert.equal(readback.production_promotion_blocker, "codex_app_server_remote_tls_required");
  assert.throws(
    () => resolveCodexAppServerConnection({ remoteUrl: "ws://codex.example.test:4500", remoteToken: "unit-test-token" }, {}),
    /codex_app_server_remote_tls_required/u
  );
});

test("Zeabur AOS may use the dedicated Codex service over private networking only with an explicit opt-in", () => {
  const env = {
    AUTOMATION_OS_CODEX_APP_SERVER_REMOTE_URL: "ws://codex-app-server.zeabur.internal:8080/",
    AUTOMATION_OS_CODEX_APP_SERVER_REMOTE_TOKEN: "unit-test-token",
    AUTOMATION_OS_CODEX_APP_SERVER_ALLOW_INTERNAL_WS: "1",
    AUTOMATION_OS_CODEX_APP_SERVER_REMOTE_CWD: "/app"
  };
  const connection = resolveCodexAppServerConnection({}, env);
  assert.equal(connection.mode, "remote_websocket");
  assert.equal(connection.endpoint, "ws://codex-app-server.zeabur.internal:8080/");
  const readback = getCodexAppServerConnectionReadback({}, env);
  assert.equal(readback.exact_blocker, null);
  assert.equal(readback.tls_required, false);
  assert.equal(readback.network_boundary, "zeabur_private_service");
  assert.equal(readback.auth_configured, true);
  assert.equal(readback.production_remote_cutover_allowed, false);
  assert.doesNotMatch(JSON.stringify(readback), /unit-test-token/u);
});

test("Zeabur internal websocket opt-in is limited to the dedicated Codex service hostname", () => {
  const env = {
    AUTOMATION_OS_CODEX_APP_SERVER_REMOTE_URL: "ws://other-service.zeabur.internal:8080/",
    AUTOMATION_OS_CODEX_APP_SERVER_REMOTE_TOKEN: "unit-test-token",
    AUTOMATION_OS_CODEX_APP_SERVER_ALLOW_INTERNAL_WS: "1"
  };
  const readback = getCodexAppServerConnectionReadback({}, env);
  assert.equal(readback.exact_blocker, "codex_app_server_remote_tls_required");
  assert.equal(readback.network_boundary, "tls_remote");
  assert.throws(() => resolveCodexAppServerConnection({}, env), /codex_app_server_remote_tls_required/u);
});

test("Zeabur internal websocket remains blocked without the explicit AOS-only opt-in", () => {
  const env = {
    AUTOMATION_OS_CODEX_APP_SERVER_REMOTE_URL: "ws://codex-app-server.zeabur.internal:8080/",
    AUTOMATION_OS_CODEX_APP_SERVER_REMOTE_TOKEN: "unit-test-token"
  };
  const readback = getCodexAppServerConnectionReadback({}, env);
  assert.equal(readback.exact_blocker, "codex_app_server_remote_tls_required");
  assert.equal(readback.network_boundary, "zeabur_private_service");
  assert.throws(() => resolveCodexAppServerConnection({}, env), /codex_app_server_remote_tls_required/u);
});

test("remote connection fails closed when auth or remote cwd is missing/invalid", () => {
  assert.equal(
    getCodexAppServerConnectionReadback({ remoteUrl: "wss://codex.example.test:4500" }, {}).exact_blocker,
    "codex_app_server_remote_auth_missing"
  );
  assert.equal(
    getCodexAppServerConnectionReadback({ remoteUrl: "wss://codex.example.test:4500" }, {}).production_promotion_blocker,
    "codex_app_server_remote_auth_missing"
  );
  assert.throws(
    () => resolveCodexAppServerConnection({
      remoteUrl: "wss://codex.example.test:4500",
      remoteToken: "unit-test-token",
      remoteCwd: "/workspace/../etc"
    }, {}),
    /codex_app_server_remote_cwd_invalid/u
  );
});

test("remote connection fails closed when Zeabur leaves a secret reference unresolved", () => {
  const env = {
    AUTOMATION_OS_CODEX_APP_SERVER_REMOTE_URL: "ws://codex-app-server.zeabur.internal:8080/",
    AUTOMATION_OS_CODEX_APP_SERVER_ALLOW_INTERNAL_WS: "1",
    AUTOMATION_OS_CODEX_APP_SERVER_REMOTE_TOKEN: "${CODEX_APP_SERVER_REMOTE_TOKEN}"
  };
  const readback = getCodexAppServerConnectionReadback({}, env);
  assert.equal(readback.auth_configured, false);
  assert.equal(readback.exact_blocker, "codex_app_server_remote_auth_unresolved_reference");
  assert.equal(readback.production_promotion_blocker, "codex_app_server_remote_auth_unresolved_reference");
  assert.throws(
    () => resolveCodexAppServerConnection({}, env),
    /codex_app_server_remote_auth_unresolved_reference/u
  );
});

test("remote auth can be resolved from a 0400 secret file without exposing its value in readback", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-codex-remote-token-"));
  const tokenFile = join(root, "token");
  try {
    writeFileSync(tokenFile, "file-token\n", { encoding: "utf8", mode: 0o400 });
    chmodSync(tokenFile, 0o400);
    const env = {
      AUTOMATION_OS_CODEX_APP_SERVER_REMOTE_URL: "wss://codex.example.test:4500/app-server",
      AUTOMATION_OS_CODEX_APP_SERVER_REMOTE_TOKEN_FILE: tokenFile
    };
    const connection = resolveCodexAppServerConnection({}, env);
    assert.equal(connection.mode, "remote_websocket");
    assert.equal(connection.token, "file-token");
    const readback = getCodexAppServerConnectionReadback({}, env);
    assert.equal(readback.auth_configured, true);
    assert.equal(readback.exact_blocker, null);
    assert.doesNotMatch(JSON.stringify(readback), /file-token|token/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("remote auth secret files fail closed when permissions are broader than 0400", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-codex-remote-token-"));
  const tokenFile = join(root, "token");
  try {
    writeFileSync(tokenFile, "file-token\n", { encoding: "utf8", mode: 0o644 });
    chmodSync(tokenFile, 0o644);
    const env = {
      AUTOMATION_OS_CODEX_APP_SERVER_REMOTE_URL: "wss://codex.example.test:4500/app-server",
      AUTOMATION_OS_CODEX_APP_SERVER_REMOTE_TOKEN_FILE: tokenFile
    };
    const readback = getCodexAppServerConnectionReadback({}, env);
    assert.equal(readback.auth_configured, false);
    assert.equal(readback.exact_blocker, "codex_app_server_remote_auth_missing");
    assert.throws(() => resolveCodexAppServerConnection({}, env), /codex_app_server_remote_auth_missing/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("remote URL rejects userinfo and query/hash credential smuggling", () => {
  for (const remoteUrl of [
    "wss://user:pass@codex.example.test:4500",
    "wss://codex.example.test:4500/app?access_token=secret",
    "wss://codex.example.test:4500/app#secret"
  ]) {
    const readback = getCodexAppServerConnectionReadback({ remoteUrl, remoteToken: "unit-test-token" }, {});
    assert.equal(readback.exact_blocker, "codex_app_server_remote_url_invalid");
    assert.equal(readback.production_promotion_blocker, "codex_app_server_remote_url_invalid");
    assert.doesNotMatch(JSON.stringify(readback), /secret|pass|unit-test-token/u);
  }
});

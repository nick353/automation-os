import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  defaultPortableWorkerProfile,
  profileShellEnv,
  readPortableWorkerProfile,
  validatePortableWorkerProfile,
  writePortableWorkerProfile
} from "../portable-worker-profile.mjs";
import { readPortableRemoteToken } from "../aos-portable-remote-worker.mjs";

test("portable worker profile resolves every machine-bound path from the selected home", () => {
  const profile = defaultPortableWorkerProfile({
    AUTOMATION_OS_PORTABLE_REMOTE_COMPANY_ID: "company_test",
    AUTOMATION_OS_PORTABLE_REMOTE_WORKER_ID: "worker_test",
    AUTOMATION_OS_CODEX_ACCOUNT_REF: "account-b",
    CODEX_CLI_PATH: "/machine-specific/codex"
  }, "/tmp/portable-worker-home");
  assert.equal(profile.repo_root, "/tmp/portable-worker-home/Documents/Codex/automation-os");
  assert.equal(profile.codex_home, "/tmp/portable-worker-home/.codex");
  assert.equal(profile.browser_use_helper, "/tmp/portable-worker-home/.local/bin/codex-browser-use");
  assert.equal(profile.codex_account_ref, "account-b");
  assert.equal(profile.codex_bin, "");
  assert.doesNotMatch(JSON.stringify(profile), /token-value|cookie-value/u);
});

test("portable worker profile shell export is constrained to non-secret configuration", () => {
  const profile = validatePortableWorkerProfile(defaultPortableWorkerProfile({
    AUTOMATION_OS_PORTABLE_REMOTE_WORKER_ID: "worker_shell",
    AUTOMATION_OS_CODEX_ACCOUNT_REF: "codex-second"
  }, "/tmp/profile-home"));
  const output = profileShellEnv(profile);
  assert.ok(output.includes("export CODEX_HOME='/tmp/profile-home/.codex'"));
  assert.ok(output.includes("export AUTOMATION_OS_CODEX_ACCOUNT_REF='codex-second'"));
  assert.ok(output.includes("export BROWSER_USE_CLI_HELPER='/tmp/profile-home/.local/bin/codex-browser-use'"));
  assert.ok(output.includes("export BROWSER_USE_RUNTIME_CONFIG='/tmp/profile-home/.browser-use-cli/browser-use-runtime.toml'"));
  assert.doesNotMatch(output, /AUTOMATION_OS_PORTABLE_REMOTE_TOKEN=/u);
  assert.doesNotMatch(output, /secret|cookie|password/u);
});

test("portable worker profile is owner-only and rejects a secret-bearing schema", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-worker-profile-test-"));
  const output = join(root, "worker-profile.json");
  const profile = defaultPortableWorkerProfile({ AUTOMATION_OS_PORTABLE_REMOTE_WORKER_ID: "worker_write" }, "/tmp/profile-write-home");
  writePortableWorkerProfile(output, profile);
  assert.equal(readPortableWorkerProfile(output).worker_id, "worker_write");
  assert.equal(readFileSync(output, "utf8").includes("token"), true);
  assert.throws(() => validatePortableWorkerProfile({ ...profile, access_token: "should-not-be-here" }), /secret_like_key/u);
});

test("portable remote worker reads a protected token file and fails closed on loose permissions", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-worker-token-test-"));
  const tokenFile = join(root, "aos.token");
  writeFileSync(tokenFile, "token-from-file\n", { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  assert.equal(readPortableRemoteToken({ AUTOMATION_OS_PORTABLE_REMOTE_TOKEN_FILE: tokenFile, AUTOMATION_OS_PORTABLE_REMOTE_TOKEN_SERVICE: "unused" }, { keychainRunner: () => { throw new Error("keychain_should_not_run"); } }), "token-from-file");
  chmodSync(tokenFile, 0o644);
  assert.equal(readPortableRemoteToken({ AUTOMATION_OS_PORTABLE_REMOTE_TOKEN_FILE: tokenFile }, { keychainRunner: () => ({ status: 0, stdout: "wrong-fallback" }) }), "");
});

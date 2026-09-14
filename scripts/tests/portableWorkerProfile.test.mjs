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
    AUTOMATION_OS_PORTABLE_LOCAL_QUEUE_COMPANY_ID: "project-a",
    AUTOMATION_OS_PORTABLE_REMOTE_WORKER_ID: "worker_test",
    AUTOMATION_OS_CODEX_ACCOUNT_REF: "account-b",
    AOS_WEB_OPERATION_BACKEND: "browser_use_cli",
    AOS_CHROME_PROFILE_SURFACE: "signed_chrome_extension_profile2",
    CODEX_CLI_PATH: "/machine-specific/codex"
  }, "/tmp/portable-worker-home");
  assert.equal(profile.repo_root, "/tmp/portable-worker-home/Documents/Codex/automation-os");
  assert.equal(profile.codex_home, "/tmp/portable-worker-home/.codex");
  assert.equal(profile.browser_use_helper, "/tmp/portable-worker-home/.local/bin/codex-browser-use");
  assert.equal(profile.web_operation_backend, "browser_use_cli");
  assert.equal(profile.local_company_id, "project-a");
  assert.equal(profile.chrome_profile_id, "profile2");
  assert.equal(profile.chrome_profile_name, "Profile 2");
  assert.equal(profile.chrome_profile_surface, "signed_chrome_extension_profile2");
  assert.equal(profile.codex_account_ref, "account-b");
  assert.equal(profile.codex_bin, "");
  assert.doesNotMatch(JSON.stringify(profile), /token-value|cookie-value/u);
});

test("same or different Codex account labels keep the AOS worker contract independent", () => {
  const baseEnv = {
    AUTOMATION_OS_PORTABLE_REMOTE_COMPANY_ID: "company_contract",
    AUTOMATION_OS_PORTABLE_REMOTE_WORKER_ID: "worker_contract",
    AUTOMATION_OS_WORKER_PROFILE_ID: "profile-primary",
    AUTOMATION_OS_CODEX_ACCOUNT_REF: "codex-primary"
  };
  const sameAccount = validatePortableWorkerProfile(defaultPortableWorkerProfile(baseEnv, "/tmp/codex-local"));
  const sameAccountServer = validatePortableWorkerProfile(defaultPortableWorkerProfile({
    ...baseEnv,
    AUTOMATION_OS_WORKER_PROFILE_ID: "profile-server",
    CODEX_HOME: "/srv/codex-home",
    AUTOMATION_OS_CODEX_ACCOUNT_REF: "codex-primary"
  }, "/tmp/ignored-home"));
  const differentAccount = validatePortableWorkerProfile(defaultPortableWorkerProfile({
    ...baseEnv,
    AUTOMATION_OS_WORKER_PROFILE_ID: "profile-secondary",
    AUTOMATION_OS_CODEX_ACCOUNT_REF: "codex-secondary"
  }, "/tmp/codex-secondary"));

  assert.equal(sameAccount.codex_account_ref, sameAccountServer.codex_account_ref);
  assert.notEqual(sameAccount.codex_home, sameAccountServer.codex_home);
  assert.notEqual(sameAccount.profile_id, sameAccountServer.profile_id);
  assert.notEqual(sameAccount.codex_account_ref, differentAccount.codex_account_ref);
  assert.notEqual(sameAccount.codex_home, differentAccount.codex_home);
  for (const profile of [sameAccount, sameAccountServer, differentAccount]) {
    assert.equal(profile.company_id, "company_contract");
    assert.equal(profile.worker_id, "worker_contract");
    assert.equal(profile.schema, "aos.portable_worker_profile.v1");
    assert.doesNotMatch(JSON.stringify(profile), /secret-value|cookie-value|token-value|auth\.json/u);
  }
  assert.doesNotMatch(profileShellEnv(differentAccount), /secret-value|cookie-value|token-value|auth\.json/u);
});

test("portable worker profile accepts the explicit AOS Chrome Companion backend", () => {
  const profile = defaultPortableWorkerProfile({ AOS_WEB_OPERATION_BACKEND: "aos-chrome-companion" }, "/tmp/companion-profile-home");
  assert.equal(profile.web_operation_backend, "aos_chrome_companion");
  assert.equal(validatePortableWorkerProfile(profile).web_operation_backend, "aos_chrome_companion");
});

test("portable worker profile shell export is constrained to non-secret configuration", () => {
  const profile = validatePortableWorkerProfile(defaultPortableWorkerProfile({
    AUTOMATION_OS_PORTABLE_REMOTE_WORKER_ID: "worker_shell",
    AUTOMATION_OS_CODEX_ACCOUNT_REF: "codex-second",
    AOS_WEB_OPERATION_BACKEND: "browser_use_cli"
  }, "/tmp/profile-home"));
  const output = profileShellEnv(profile);
  assert.ok(output.includes("export CODEX_HOME='/tmp/profile-home/.codex'"));
  assert.ok(output.includes("export AUTOMATION_OS_CODEX_ACCOUNT_REF='codex-second'"));
  assert.ok(output.includes("export BROWSER_USE_CLI_HELPER='/tmp/profile-home/.local/bin/codex-browser-use'"));
  assert.ok(output.includes("export BROWSER_USE_RUNTIME_CONFIG='/tmp/profile-home/.browser-use-cli/browser-use-runtime.toml'"));
  assert.ok(output.includes("export AOS_WEB_OPERATION_BACKEND='browser_use_cli'"));
  assert.ok(output.includes("export AUTOMATION_OS_PORTABLE_LOCAL_QUEUE_COMPANY_ID='project-a'") === false);
  assert.ok(output.includes("export AOS_CHROME_PROFILE_DIRECTORY='Profile 2'"));
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

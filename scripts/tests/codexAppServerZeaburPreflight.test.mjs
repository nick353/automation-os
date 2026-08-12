import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("Zeabur Codex App Server source preflight is read-only and secret-free", () => {
  const output = execFileSync(process.execPath, ["scripts/codex-app-server-zeabur-preflight.mjs"], { encoding: "utf8" });
  const result = JSON.parse(output);
  assert.equal(result.schema, "codex_app_server_zeabur_source_preflight.v1");
  assert.equal(result.status, "ready_for_external_deploy_preflight");
  assert.equal(result.exact_blocker, null);
  assert.equal(result.deployment_authorized, false);
  assert.equal(result.external_action_executed, false);
  assert.equal(result.secrets_read, false);
  assert.equal(result.checks.entrypoint_uses_secret_file, true);
  assert.equal(result.checks.entrypoint_defaults_loopback, true);
  assert.equal(result.checks.entrypoint_requires_non_loopback_approval, true);
  assert.equal(result.checks.dockerfile_keeps_apt_signature_verification, true);
  assert.equal(result.checks.config_reference_exists, true);
  assert.equal(result.checks.config_reference_uses_secret_free_envsubst_file, true);
  assert.equal(result.checks.config_reference_defaults_fail_closed, true);
  assert.equal(result.checks.config_reference_has_no_real_secret, true);
  assert.equal(result.checks.readme_declares_private_readiness, true);
  assert.equal(result.checks.readme_declares_private_network_mac_boundary, true);
  assert.ok(Object.values(result.source_artifacts).every((artifact) => artifact.exists && /^[a-f0-9]{64}$/u.test(artifact.sha256)));
  assert.doesNotMatch(output, /CODEX_APP_SERVER_TOKEN=[A-Za-z0-9_-]{20,}/u);
});

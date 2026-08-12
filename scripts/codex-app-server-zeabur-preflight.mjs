#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repoRoot = resolve(process.env.AUTOMATION_OS_REPO_ROOT || process.cwd());
const generatedAt = new Date().toISOString();
const files = {
  dockerfile: join(repoRoot, "ops/zeabur/Dockerfile.codex-app-server"),
  entrypoint: join(repoRoot, "ops/zeabur/start-codex-app-server.sh"),
  envExample: join(repoRoot, "ops/zeabur/codex-app-server.env.example"),
  configReference: join(repoRoot, "ops/zeabur/codex-app-server-config-reference.yaml"),
  readme: join(repoRoot, "ops/zeabur/README.md")
};

function read(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function has(text, fragment) {
  return typeof text === "string" && text.includes(fragment);
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const contents = Object.fromEntries(Object.entries(files).map(([key, path]) => [key, read(path)]));
const checks = {
  dockerfile_exists: contents.dockerfile !== null,
  dockerfile_pins_codex_cli: has(contents.dockerfile, "@openai/codex@${CODEX_CLI_VERSION}"),
  dockerfile_exposes_app_server_port: has(contents.dockerfile, "EXPOSE 4500"),
  dockerfile_has_readyz_healthcheck: has(contents.dockerfile, "/readyz"),
  dockerfile_keeps_apt_signature_verification: has(contents.dockerfile, "apt-get -o APT::Sandbox::User=root update") && !has(contents.dockerfile, "--allow-unauthenticated") && !has(contents.dockerfile, "Acquire::AllowInsecureRepositories"),
  entrypoint_exists: contents.entrypoint !== null,
  entrypoint_requires_secret_manager_token: has(contents.entrypoint, "CODEX_APP_SERVER_TOKEN_FILE must point to a readable host-secret file"),
  entrypoint_uses_secret_file: has(contents.entrypoint, "--ws-auth capability-token") && has(contents.entrypoint, "--ws-token-file"),
  entrypoint_defaults_loopback: has(contents.entrypoint, "CODEX_APP_SERVER_BIND_HOST:-127.0.0.1"),
  entrypoint_requires_non_loopback_approval: has(contents.entrypoint, "CODEX_APP_SERVER_NON_LOOPBACK_APPROVED") && has(contents.entrypoint, "CODEX_APP_SERVER_TLS_TERMINATED"),
  env_example_exists: contents.envExample !== null,
  env_example_has_no_real_secret: contents.envExample === null || has(contents.envExample, "<secret-manager-only>"),
  config_reference_exists: contents.configReference !== null,
  config_reference_uses_secret_free_envsubst_file: has(contents.configReference, "path: /run/secrets/codex-app-server-token") && has(contents.configReference, "envsubst: true") && has(contents.configReference, "permission: 256") && has(contents.configReference, "${CODEX_APP_SERVER_REMOTE_TOKEN}"),
  config_reference_defaults_fail_closed: has(contents.configReference, "CODEX_APP_SERVER_BIND_HOST:\n    default: 127.0.0.1") && has(contents.configReference, "CODEX_APP_SERVER_NON_LOOPBACK_APPROVED:\n    default: \"0\"") && has(contents.configReference, "CODEX_APP_SERVER_TLS_TERMINATED:\n    default: \"0\"") ,
  config_reference_has_no_real_secret: contents.configReference === null || !/(?:token|secret)\s*[:=]\s*["']?[A-Za-z0-9_-]{32,}/iu.test(contents.configReference),
  readme_declares_experimental_boundary: has(contents.readme, "experimental") && has(contents.readme, "unsupported"),
  readme_declares_no_effect_promotion_gates: has(contents.readme, "Fresh promotion gates") && has(contents.readme, "external effect"),
  readme_declares_private_readiness: has(contents.readme, "backend port is not directly") && has(contents.readme, "reachable") && has(contents.readme, "private boundary"),
  readme_declares_private_network_mac_boundary: has(contents.readme, "not a route reachable directly from the Mac worker") && has(contents.readme, "TLS-terminated `wss://` ingress")
};

const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([id]) => id);
const sourceArtifacts = Object.fromEntries(Object.entries(files).map(([key, path]) => [
  key,
  contents[key] === null
    ? { path: relative(repoRoot, path), exists: false }
    : { path: relative(repoRoot, path), exists: true, sha256: sha256(contents[key]) }
]));

const result = {
  schema: "codex_app_server_zeabur_source_preflight.v1",
  generated_at: generatedAt,
  scope: "source_only_no_deploy_no_secret_read",
  status: failedChecks.length ? "blocked" : "ready_for_external_deploy_preflight",
  exact_blocker: failedChecks.length ? `codex_app_server_zeabur_source_check_failed:${failedChecks[0]}` : null,
  checks,
  failed_checks: failedChecks,
  source_artifacts: sourceArtifacts,
  deployment_authorized: false,
  external_action_executed: false,
  secrets_read: false,
  next_action: failedChecks.length
    ? "Repair the failed source checks, then rerun this read-only preflight."
    : "Use the external Zeabur deployment/secret boundary, then capture fresh /readyz, authenticated WSS initialize, thread/turn, and cleanup readback; this artifact is not deployment proof."
};

console.log(JSON.stringify(result, null, 2));
process.exitCode = failedChecks.length ? 2 : 0;

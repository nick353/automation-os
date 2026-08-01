import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const authority = await import("../serviceReadiness/browserUseAuthority.js");

function baseAuthority(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    schema: authority.BROWSER_USE_AUTHORITY_SCHEMA_V1,
    browser_surface: authority.BROWSER_USE_SURFACE,
    authority_id: "authority-browser-use-1",
    nonce: "nonce-browser-use-123456",
    issuer: "automation_os_root",
    issued_at: new Date(now - 1_000).toISOString(),
    not_before: new Date(now - 500).toISOString(),
    expires_at: new Date(now + 60_000).toISOString(),
    run_id: "run-browser-use-1",
    session: "session-browser-use-1",
    stage_id: "stage-browser-use-1",
    attempt: 1,
    idempotency_key: "effect-browser-use-1",
    allowed_origins: ["https://example.com"],
    account_identity: "public-anonymous",
    data_exposure: "public-page-title-state-only",
    side_effect_scope: "none",
    approval: {
      approved: true,
      subject: "automation-os-owner",
      source: "current-user-turn",
      scope: "none",
      approved_at: new Date(now - 500).toISOString()
    },
    readback_required: true,
    no_fallback: true,
    helper_path: authority.BROWSER_USE_HELPER_PATH,
    runtime_config_path: authority.BROWSER_USE_RUNTIME_CONFIG_PATH,
    ...overrides
  };
}

function writeAuthority(value: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "automation-os-browser-use-authority-"));
  chmodSync(root, 0o700);
  const file = join(root, "authority.json");
  writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return { root, file };
}

test("authority parser requires structured approval and root provenance", () => {
  assert.equal(authority.parseBrowserUseAuthority(baseAuthority()).browser_surface, "browser_use_cli");
  assert.throws(() => authority.parseBrowserUseAuthority(baseAuthority({ approval: true })), /approval_invalid/);
  assert.throws(() => authority.parseBrowserUseAuthority(baseAuthority({ issuer: "caller" })), /provenance_invalid/);
  assert.throws(() => authority.parseBrowserUseAuthority(baseAuthority({ token: "secret" })), /secret_field_forbidden/);
});

test("authority loader binds current run/session/stage/attempt and immutable envelope digest", () => {
  const value = baseAuthority();
  const written = writeAuthority(value);
  const digest = authority.authoritySha256(written.file);
  const loaded = authority.loadBrowserUseAuthority({
    authorityPath: written.file,
    expected: { run_id: value.run_id as string, session: value.session as string, stage_id: value.stage_id as string, attempt: 1 },
    envelope: {
      schema: authority.BROWSER_USE_AUTHORITY_ENVELOPE_SCHEMA_V1,
      issuer: "automation_os_root",
      authority_sha256: digest,
      authority_id: value.authority_id as string,
      nonce: value.nonce as string,
      run_id: value.run_id as string,
      session: value.session as string,
      stage_id: value.stage_id as string,
      attempt: 1
    }
  });
  assert.equal(loaded.authority_sha256, digest);
  assert.throws(() => authority.loadBrowserUseAuthority({
    authorityPath: written.file,
    expected: { run_id: "run-other", session: value.session as string, stage_id: value.stage_id as string, attempt: 1 },
    envelope: {
      schema: authority.BROWSER_USE_AUTHORITY_ENVELOPE_SCHEMA_V1,
      issuer: "automation_os_root",
      authority_sha256: digest,
      authority_id: value.authority_id as string,
      nonce: value.nonce as string,
      run_id: value.run_id as string,
      session: value.session as string,
      stage_id: value.stage_id as string,
      attempt: 1
    }
  }), /binding_mismatch:run_id/);
});

test("authority loader rejects symlink, unsafe file mode, private origin, and expired window", () => {
  const value = baseAuthority();
  const written = writeAuthority(value);
  const symlink = join(written.root, "authority-link.json");
  symlinkSync(written.file, symlink);
  assert.throws(() => authority.authoritySha256(symlink), /file_invalid/);
  chmodSync(written.file, 0o644);
  assert.throws(() => authority.authoritySha256(written.file), /file_invalid/);
  assert.throws(() => authority.parseBrowserUseAuthority(baseAuthority({ allowed_origins: ["http://127.0.0.1:8080"] })), /private_origin_rejected/);
  assert.throws(() => authority.parseBrowserUseAuthority(baseAuthority({ expires_at: new Date(Date.now() - 1_000).toISOString() })), /time_window_invalid/);
});

test("manifest parser allows only public single-use canonical Browser Use CLI", () => {
  const parsed = authority.parseBrowserUseManifest({
    schema: "automation_kernel_manifest.v1",
    browser_use: {
      surface: "browser_use_cli",
      helper_path: authority.BROWSER_USE_HELPER_PATH,
      runtime_config_path: authority.BROWSER_USE_RUNTIME_CONFIG_PATH,
      mode: "public",
      lifecycle: "single-use",
      allowed_origins: ["https://example.com"],
      requested_session_id: "automation-os-workflow",
      authority_ref: null,
      authority_expiry: null,
      external_action_scope: "none",
      recording_required: false,
      proof_policy: "state-title-url",
      cleanup_policy: "owned-process-profile-port-lock",
      no_fallback: true
    }
  });
  assert.equal(parsed.browser_use.surface, "browser_use_cli");
  assert.throws(() => authority.parseBrowserUseManifest({
    schema: "automation_kernel_manifest.v1",
    browser_use: {
      surface: "browser_use_cli",
      helper_path: authority.BROWSER_USE_HELPER_PATH,
      runtime_config_path: authority.BROWSER_USE_RUNTIME_CONFIG_PATH,
      mode: "authorized",
      lifecycle: "scheduled",
      allowed_origins: ["https://example.com"],
      requested_session_id: "automation-os-authorized-workflow",
      authority_ref: "authority.json",
      authority_expiry: null,
      external_action_scope: "submit",
      recording_required: true,
      proof_policy: "state-title-url-provider-receipt",
      cleanup_policy: "owned-process-profile-port-lock",
      no_fallback: true
    }
  }), /authority_expiry_required/);
  assert.throws(() => authority.parseBrowserUseManifest({
    schema: "automation_kernel_manifest.v1",
    browser_use: {
      surface: "browser_use_cli",
      helper_path: authority.BROWSER_USE_HELPER_PATH,
      runtime_config_path: authority.BROWSER_USE_RUNTIME_CONFIG_PATH,
      mode: "authorized",
      lifecycle: "scheduled",
      allowed_origins: ["https://example.com"],
      requested_session_id: "automation-os-authorized-workflow",
      authority_ref: "authority.json",
      authority_expiry: new Date(Date.now() - 1_000).toISOString(),
      external_action_scope: "submit",
      recording_required: true,
      proof_policy: "state-title-url-provider-receipt",
      cleanup_policy: "owned-process-profile-port-lock",
      no_fallback: true
    }
  }), /authority_expiry_past/);
  assert.throws(() => authority.parseBrowserUseManifest({
    schema: "automation_kernel_manifest.v1",
    browser_use: {
      surface: "browser_use_cli",
      helper_path: authority.BROWSER_USE_HELPER_PATH,
      runtime_config_path: authority.BROWSER_USE_RUNTIME_CONFIG_PATH,
      mode: "public",
      lifecycle: "single-use",
      allowed_origins: ["https://example.com"],
      requested_session_id: "automation-os-public-workflow",
      authority_ref: "authority.json",
      authority_expiry: null,
      external_action_scope: "none",
      recording_required: false,
      proof_policy: "state-title-url",
      cleanup_policy: "owned-process-profile-port-lock",
      no_fallback: true
    }
  }), /public_authority_ref_forbidden/);
  assert.throws(() => authority.parseBrowserUseManifest({
    schema: "automation_kernel_manifest.v1",
    browser_use: {
      surface: "in_app_browser",
      helper_path: authority.BROWSER_USE_HELPER_PATH,
      runtime_config_path: authority.BROWSER_USE_RUNTIME_CONFIG_PATH,
      mode: "public",
      lifecycle: "single-use",
      allowed_origins: ["https://example.com"],
      requested_session_id: "automation-os-workflow",
      authority_ref: null,
      authority_expiry: null,
      external_action_scope: "none",
      recording_required: false,
      proof_policy: "state-title-url",
      cleanup_policy: "owned-process-profile-port-lock",
      no_fallback: true
    }
  }), /runtime_binding_invalid/);
});

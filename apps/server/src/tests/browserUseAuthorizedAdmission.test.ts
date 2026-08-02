import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BrowserUseAuthorityV1 } from "../serviceReadiness/browserUseAuthority.js";

const authority = await import("../serviceReadiness/browserUseAuthority.js");
const admission = await import("../serviceReadiness/browserUseAuthorizedAdmission.js");

function baseAuthority(overrides: Partial<BrowserUseAuthorityV1> = {}): BrowserUseAuthorityV1 {
  const now = Date.now();
  return {
    schema: authority.BROWSER_USE_AUTHORITY_SCHEMA_V1,
    browser_surface: authority.BROWSER_USE_SURFACE,
    authority_id: "authority-browser-use-admission-1",
    nonce: "nonce-browser-use-admission-123456",
    issuer: "automation_os_root",
    issued_at: new Date(now - 1_000).toISOString(),
    not_before: new Date(now - 500).toISOString(),
    expires_at: new Date(now + 60_000).toISOString(),
    run_id: "run-browser-use-admission-1",
    session: "session-browser-use-admission-1",
    stage_id: "stage-browser-use-admission-1",
    attempt: 1,
    idempotency_key: "effect-browser-use-admission-1",
    allowed_origins: ["https://example.com"],
    account_identity: "authorized-test-marker",
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

function setup() {
  const root = mkdtempSync(join(tmpdir(), "automation-os-browser-use-admission-"));
  chmodSync(root, 0o700);
  const value = baseAuthority();
  const expected = {
    run_id: value.run_id as string,
    session: value.session as string,
    stage_id: value.stage_id as string,
    attempt: 1
  };
  return {
    root,
    value,
    expected,
    input: {
      run_root: root,
      authority: value,
      expected,
      workflow_id: "daily-ai" as const,
      attempt_id: "attempt-browser-use-admission-1",
      profile_root: `/Users/nichikatanaka/.browser-use-cli/profiles/scheduled/${value.run_id}`,
      reserved_port: 19880,
      lock_path: `/Users/nichikatanaka/.browser-use-cli/locks/${value.run_id}.lock`
    }
  };
}

test("authorized admission atomically creates strict files and stops at data-only handoff", () => {
  const fixture = setup();
  const files = admission.createBrowserUseAuthorizedAuthorityFiles(fixture.input);
  const result = admission.claimBrowserUseAuthorizedAdmission(fixture.input);
  assert.equal(result.schema, admission.BROWSER_USE_AUTHORIZED_ADMISSION_SCHEMA_V1);
  assert.equal(result.adapter_handoff_allowed, false);
  assert.equal(result.helper_launched, false);
  assert.equal(result.external_action_executed, false);
  assert.equal(result.prior_claim_reuse, false);
  assert.equal(result.runtime_binding.mode, "authorized");
  assert.equal(result.runtime_binding.status, "blocked");
  assert.equal(result.runtime_binding.exact_blocker, "service_readiness_browser_use_effective_session_missing");
  assert.equal(files.authority_sha256, result.authority_sha256);
  assert.equal(statSync(files.paths.authority_path).mode & 0o777, 0o600);
  assert.equal(statSync(files.paths.envelope_path).mode & 0o777, 0o600);
  assert.equal(statSync(files.paths.claim_path).mode & 0o777, 0o600);
  const claim = JSON.parse(readFileSync(files.paths.claim_path, "utf8")) as Record<string, unknown>;
  assert.equal(claim.adapter_handoff_allowed, false);
  assert.equal(claim.external_action_executed, false);
  assert.equal("approval" in claim, false);
});

test("authorized admission rejects replay and binding mismatch without overwriting the claim", () => {
  const fixture = setup();
  admission.createBrowserUseAuthorizedAuthorityFiles(fixture.input);
  admission.claimBrowserUseAuthorizedAdmission(fixture.input);
  assert.throws(() => admission.claimBrowserUseAuthorizedAdmission(fixture.input), /claim_replay_forbidden/);
  const mismatched = {
    ...fixture.input,
    expected: { ...fixture.expected, run_id: "run-other" }
  };
  assert.throws(() => admission.claimBrowserUseAuthorizedAdmission(mismatched), /binding_mismatch:run_id/);
});

test("authorized admission rejects a partial claim and unsafe run-root permissions", () => {
  const partial = setup();
  admission.createBrowserUseAuthorizedAuthorityFiles(partial.input);
  const claimPath = join(partial.root, admission.BROWSER_USE_AUTHORIZED_CLAIM_FILE);
  writeFileSync(claimPath, "{\"partial\":true}\n", { mode: 0o600 });
  assert.throws(() => admission.claimBrowserUseAuthorizedAdmission(partial.input), /claim_replay_forbidden/);

  const unsafe = setup();
  chmodSync(unsafe.root, 0o755);
  assert.throws(() => admission.createBrowserUseAuthorizedAuthorityFiles(unsafe.input), /run_root_invalid/);

  const unsafeParent = mkdtempSync(join(tmpdir(), "automation-os-browser-use-admission-unsafe-parent-"));
  chmodSync(unsafeParent, 0o700);
  const nestedRoot = join(unsafeParent, "run-root");
  mkdirSync(nestedRoot, { mode: 0o700 });
  chmodSync(unsafeParent, 0o777);
  assert.throws(() => admission.createBrowserUseAuthorizedAuthorityFiles({ ...setup().input, run_root: nestedRoot }), /parent_mode_invalid/);
});

test("authorized admission rejects stale approval and symlinked run roots", () => {
  const stale = setup();
  stale.input.authority = baseAuthority({
    approval: {
      approved: true,
      subject: "automation-os-owner",
      source: "current-user-turn",
      scope: "none",
      approved_at: new Date(Date.now() - 10 * 60 * 1000).toISOString()
    }
  });
  assert.throws(() => admission.createBrowserUseAuthorizedAuthorityFiles(stale.input), /approval_stale/);

  const symlinkTarget = mkdtempSync(join(tmpdir(), "automation-os-browser-use-admission-link-target-"));
  chmodSync(symlinkTarget, 0o700);
  const linkParent = mkdtempSync(join(tmpdir(), "automation-os-browser-use-admission-link-parent-"));
  chmodSync(linkParent, 0o700);
  const link = join(linkParent, "run-root");
  symlinkSync(symlinkTarget, link);
  assert.throws(() => admission.createBrowserUseAuthorizedAuthorityFiles({ ...setup().input, run_root: link }), /run_root_invalid/);
});

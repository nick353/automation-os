import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import {
  BROWSER_USE_CLI_SEMANTIC_READBACK_SCHEMA,
  parseBrowserUseCliStartDescriptor,
  validateBrowserUseCliSemanticReadback,
} from "/Users/nichikatanaka/.codex/skills/automation-kernel-run/scripts/browser-use-cli-stage-adapter.mjs";

const fixturePath = new URL("./fixtures/browser-use-semantic-readback.v1.json", import.meta.url);
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

test("accepts the fixed public semantic readback fixture", () => {
  const value = validateBrowserUseCliSemanticReadback(fixture);
  assert.equal(value.schema, BROWSER_USE_CLI_SEMANTIC_READBACK_SCHEMA);
  assert.equal(value.url, "https://example.com/");
  assert.equal(value.title_length, 14);
  assert.equal(value.state.ready_state, "complete");
  assert.equal(value.redirect_count, 0);
  assert.equal(value.final_dns_resolution.private_address_count, 0);
});

test("rejects wrong URL, title, state, redirect, DNS, and extra/raw fields", () => {
  for (const mutated of [
    { ...fixture, url: "https://evil.example/" },
    { ...fixture, title_sha256: "bad" },
    { ...fixture, state: { ...fixture.state, ready_state: "loading" } },
    { ...fixture, redirect_count: 1 },
    { ...fixture, final_dns_resolution: { ...fixture.final_dns_resolution, private_address_count: 1 } },
    { ...fixture, page_body: "must-not-pass" },
  ]) {
    assert.throws(() => validateBrowserUseCliSemanticReadback(mutated), /browser_use_cli_semantic_readback_/);
  }
});

test("does not accept arbitrary evaluation or raw title/body values", () => {
  assert.throws(() => validateBrowserUseCliSemanticReadback({ ...fixture, eval: "document.body.innerHTML" }), /browser_use_cli_semantic_readback_additional_field/);
  assert.throws(() => validateBrowserUseCliSemanticReadback({ ...fixture, title: "Example Domain" }), /browser_use_cli_semantic_readback_additional_field/);
});

test("rejects a descriptor carrying the pre-mutation helper hash", () => {
  const startFixture = JSON.parse(fs.readFileSync(new URL("./fixtures/browser-use-recording-start.v1.json", import.meta.url), "utf8"));
  const helperPath = "/Users/nichikatanaka/.local/bin/codex-browser-use";
  const currentHelperHash = crypto.createHash("sha256").update(fs.readFileSync(helperPath)).digest("hex");
  assert.throws(() => parseBrowserUseCliStartDescriptor({ ...startFixture, helper_sha256: "c717615b30cb7d28fc4d2594534604b94edf8e91f4bf9438ed90d6f2f75f4b13" }, {
    automationId: startFixture.automation_id,
    runId: startFixture.run_id,
    stageId: startFixture.stage_id,
    requestedSession: startFixture.requested_session,
    port: startFixture.port,
    allowedOrigins: startFixture.allowed_origins,
    expiresAt: startFixture.expires_at,
    helperSha256: currentHelperHash,
    requireHelperHash: true,
  }), /browser_use_cli_helper_hash_mismatch/);
});

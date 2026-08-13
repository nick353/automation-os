import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

test("recovery source preflight is secret-free and contains the portable recovery boundary", () => {
  const output = execFileSync(process.execPath, ["scripts/recovery-preflight.mjs"], { encoding: "utf8" });
  const result = JSON.parse(output);
  assert.equal(result.schema, "aos.recovery_source_preflight.v1");
  assert.equal(result.status, "ready_for_recovery");
  assert.equal(result.secrets_read, false);
  assert.equal(result.external_action_executed, false);
  assert.ok(Object.values(result.required_files).every(Boolean));
  assert.doesNotMatch(output, /(?:AUTOMATION_OS_WRITE_TOKEN|CODEX_APP_SERVER_REMOTE_TOKEN)=([A-Za-z0-9_-]{20,})/u);
});

test("recovery documentation keeps Codex Server and Browser Use on their intended sides of the boundary", () => {
  const runbook = readFileSync("docs/RECOVERY_RUNBOOK.md", "utf8");
  assert.match(runbook, /same production PostgreSQL database/u);
  assert.match(runbook, /Do not run Browser Use inside the AOS or Codex Server host/u);
  assert.match(runbook, /AUTOMATION_OS_CODEX_APP_SERVER_REMOTE_URL/u);
  assert.match(runbook, /persistent volume mounted at `CODEX_HOME`/u);
  assert.match(runbook, /external effects/u);
});

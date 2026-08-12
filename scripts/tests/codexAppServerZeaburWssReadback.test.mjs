import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";

const script = "scripts/codex-app-server-zeabur-wss-readback.mjs";

test("Zeabur WSS readback is syntax-valid and keeps the credential boundary", () => {
  execFileSync(process.execPath, ["--check", script], { encoding: "utf8" });
  const source = fs.readFileSync(script, "utf8");
  assert.match(source, /Authorization:\s*`Bearer \$\{token\}`/u);
  assert.match(source, /account\/read/u);
  assert.match(source, /thread\/start/u);
  assert.match(source, /turn\/start/u);
  assert.match(source, /external_action_executed: false/u);
  assert.match(source, /never prints protocol payloads or secrets/u);
  assert.doesNotMatch(source, /console\.log\([^)]*token/iu);
});

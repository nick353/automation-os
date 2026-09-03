import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("connector execution boundary delegates provider auth to Codex App Server/MCP", () => {
  const boundary = readFileSync("docs/connector-execution-boundary.md", "utf8");
  const workerContract = readFileSync("docs/portable-worker-contract.md", "utf8");
  const pluginSkill = readFileSync("/Users/nichikatanaka/plugins/aos-automation/skills/aos-automation/SKILL.md", "utf8");

  assert.match(boundary, /does not implement Google OAuth/iu);
  assert.match(boundary, /Codex App Server \/ MCP/iu);
  assert.match(boundary, /Gmail/iu);
  assert.match(boundary, /Google Drive/iu);
  assert.match(boundary, /Google Calendar/iu);
  assert.match(boundary, /Supabase/iu);
  assert.match(boundary, /Chrome Plugin Profile 2/iu);
  assert.match(boundary, /no implicit\s+fallback/iu);
  assert.match(workerContract, /connector-execution-boundary\.md/u);
  assert.match(pluginSkill, /Supabase/iu);
});

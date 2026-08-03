import test from "node:test";
import assert from "node:assert/strict";

import { selectCodexBin } from "../portable-external-runner.mjs";

test("AUTOMATION_OS_CODEX_BIN takes precedence over CODEX_CLI_PATH", () => {
  assert.equal(
    selectCodexBin({
      AUTOMATION_OS_CODEX_BIN: "/custom/automation-os/codex",
      CODEX_CLI_PATH: "/custom/launch-agent/codex"
    }),
    "/custom/automation-os/codex"
  );
});

test("CODEX_CLI_PATH is used when the explicit override is absent", () => {
  assert.equal(
    selectCodexBin({ CODEX_CLI_PATH: "/custom/launch-agent/codex" }),
    "/custom/launch-agent/codex"
  );
});

test("the stable fallback is used when neither path is configured", () => {
  assert.equal(selectCodexBin({}), "/usr/local/bin/codex");
});

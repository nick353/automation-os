import assert from "node:assert/strict";
import test from "node:test";
import { resolveCodexBin } from "../codex/codexBin.js";

test("resolveCodexBin prefers explicit worker/planner settings", () => {
  assert.equal(
    resolveCodexBin(["AUTOMATION_OS_CHILD_CODEX_BIN"], {
      AUTOMATION_OS_CHILD_CODEX_BIN: "/tmp/child-codex",
      AUTOMATION_OS_CODEX_PLANNER_BIN: "/tmp/planner-codex",
      AUTOMATION_OS_CODEX_BIN: "/tmp/global-codex",
      CODEX_CLI_PATH: "/tmp/official-codex"
    }),
    "/tmp/child-codex"
  );
  assert.equal(
    resolveCodexBin(["AUTOMATION_OS_CODEX_PLANNER_BIN"], {
      AUTOMATION_OS_CODEX_PLANNER_BIN: "/tmp/planner-codex",
      AUTOMATION_OS_CODEX_BIN: "/tmp/global-codex",
      CODEX_CLI_PATH: "/tmp/official-codex"
    }),
    "/tmp/planner-codex"
  );
});

test("resolveCodexBin falls back to the configured official CLI and ignores blanks", () => {
  assert.equal(
    resolveCodexBin([], {
      AUTOMATION_OS_CODEX_BIN: "   ",
      CODEX_CLI_PATH: " /tmp/official-codex "
    }),
    "/tmp/official-codex"
  );
  assert.equal(resolveCodexBin([], {}), "codex");
});

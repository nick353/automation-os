import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const runnerPath = "/Users/nichikatanaka/.codex/automations/daily-backup-safety-check/scripts/run_daily_backup_snapshot.sh";
const runner = existsSync(runnerPath) ? readFileSync(runnerPath, "utf8") : null;
const fn = runner?.match(/^push_fixed_backup_commit\(\) \{[\s\S]*?^\}/m)?.[0];
if (runner !== null) assert.ok(fn, "registered runner recovery function must be present");

for (const scenario of ["transient", "delivered_then_disconnect", "remote_changed", "auth_failure", "retry_failed", "already_present"]) {
  test(`Backup push recovery: ${scenario}`, { skip: runner === null ? "local registered Backup runner is not installed on this host" : false }, () => {
    const temp = mkdtempSync(join(tmpdir(), "aos-backup-push-test-"));
    try {
      const script = `set -u; set -o pipefail
${fn}
git() {
  shift; shift
  if [ "$1" = ls-remote ]; then
    if [ "$SCENARIO" = already_present ] || [ -f "$TEST_DIR/success" ]; then printf 'newcommit refs/heads/main\n'
    elif [ -f "$TEST_DIR/attempt" ] && [ "$SCENARIO" = delivered_then_disconnect ]; then printf 'newcommit refs/heads/main\n'
    elif [ -f "$TEST_DIR/attempt" ] && [ "$SCENARIO" = remote_changed ]; then printf 'foreigncommit refs/heads/main\n'
    else printf 'oldcommit refs/heads/main\n'; fi
  elif [ "$1" = -c ]; then
    [ "$2" = pack.useSparse=false ] && [ "$3" = push ] || return 10
    shift; shift
    [ "$2" = origin ] && [ "$3" = newcommit:refs/heads/main ] || return 9
    printf 'push\n' >> "$TEST_DIR/calls"
    if [ -f "$TEST_DIR/attempt" ] && [ "$SCENARIO" = transient ]; then touch "$TEST_DIR/success"; return 0; fi
    touch "$TEST_DIR/attempt"
    if [ "$SCENARIO" = auth_failure ]; then printf 'authentication failed\n' >&2; else printf 'RPC failed; HTTP 408\n' >&2; fi
    return 1
  else return 8; fi
}
push_fixed_backup_commit fixture newcommit "$TEST_DIR/error"
`;
      const result = spawnSync("bash", ["-c", script], { env: { ...process.env, SCENARIO: scenario, TEST_DIR: temp }, encoding: "utf8" });
      const expectedSuccess = ["transient", "delivered_then_disconnect", "already_present"].includes(scenario);
      assert.equal(result.status === 0, expectedSuccess, result.stderr);
      let calls = 0;
      try { calls = readFileSync(join(temp, "calls"), "utf8").trim().split("\n").length; } catch {}
      assert.equal(calls, scenario === "already_present" ? 0 : ["transient", "retry_failed"].includes(scenario) ? 2 : 1);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
}

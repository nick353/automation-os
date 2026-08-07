import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-session-dir-precedence-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");
process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT = "1";

const db = await import("../db/client.js");
const { exportObsidianVault } = await import("../obsidian/exporter.js");

test("explicit Codex sessions directory takes precedence over the global redacted index", () => {
  db.initDb();
  db.resetDemoData();

  const vaultPath = join(tempRoot, "vault");
  const docsDir = join(tempRoot, "docs");
  const sessionsDir = join(tempRoot, "explicit-sessions");
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    join(sessionsDir, "explicit-session.jsonl"),
    [
      JSON.stringify({ type: "session_meta", payload: { id: "explicit-session", cwd: "/tmp/explicit-cwd", thread_source: "user" } }),
      JSON.stringify({ role: "user", text: "explicit session user marker" }),
      JSON.stringify({ role: "assistant", text: "explicit session assistant marker" })
    ].join("\n") + "\n"
  );

  exportObsidianVault({
    vaultPath,
    docsDir,
    codexSessionsDir: sessionsDir,
    refreshCodexSessionIndex: false
  });

  const activeSessions = readFileSync(join(vaultPath, "01_Control Panel", "Active Sessions.md"), "utf8");
  assert.match(activeSessions, /explicit-session/);
  assert.match(activeSessions, /explicit session user marker/);
});

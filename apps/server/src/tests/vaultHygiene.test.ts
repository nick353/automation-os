import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { archiveStaleUntitledBases } from "../obsidian/vaultHygiene.js";

test("Vault hygiene archives only stale, exact, untitled default Bases without deleting them", () => {
  const vaultPath = mkdtempSync(join(tmpdir(), "automation-os-vault-hygiene-"));
  const now = new Date("2026-07-15T10:00:00.000Z");
  const old = new Date("2026-07-01T10:00:00.000Z");
  const emptyBody = "views:\n  - type: table\n    name: 表\n";
  const stale = join(vaultPath, "無題のファイル.base");
  const recent = join(vaultPath, "無題のファイル 1.base");
  const customized = join(vaultPath, "無題のファイル 2.base");
  writeFileSync(stale, emptyBody);
  writeFileSync(recent, emptyBody);
  writeFileSync(customized, `${emptyBody}filters:\n  and: []\n`);
  utimesSync(stale, old, old);
  utimesSync(customized, old, old);

  const result = archiveStaleUntitledBases({ vaultPath, now });

  assert.equal(result.ok, true);
  assert.deepEqual(result.archived, ["無題のファイル.base"]);
  assert.deepEqual(result.skipped, ["無題のファイル 1.base", "無題のファイル 2.base"]);
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(recent), true);
  assert.equal(existsSync(customized), true);
  assert.ok(result.archiveDir);
  assert.equal(readFileSync(join(result.archiveDir, "無題のファイル.base"), "utf8"), emptyBody);
});

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, ftruncateSync, mkdtempSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const script = "/Users/nichikatanaka/.codex/automations/daily-backup-safety-check/scripts/measure_selected_backup_bytes.mjs";
const available = existsSync(script);
const measure = available ? (await import(pathToFileURL(script).href)).measureSelectedBackupBytes : null;
const options = { skip: !available && "fixed Mac Backup size helper is not installed" };
function fixture(fn) {
  const root = mkdtempSync(path.join(tmpdir(), "aos-backup-size-test-"));
  try { execFileSync("git", ["init", "-q", root]); return fn(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test("Backup size batches selected paths while keeping spaces/newlines and ignore rules", options, () => fixture((root) => {
  writeFileSync(path.join(root, ".gitignore"), "ignored\n");
  writeFileSync(path.join(root, "tracked"), "123");
  execFileSync("git", ["-C", root, "add", "tracked", ".gitignore"]);
  writeFileSync(path.join(root, "space and\nnewline"), "12345");
  writeFileSync(path.join(root, "ignored"), "x".repeat(100));
  const result = measure([{ label: "test", root }]);
  assert.deepEqual(result, { total_bytes: 16, selected_files: 3 });
  const cli = spawnSync(process.execPath, [script, "104857600", "test", "--", root], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout, "16\n");
}));

test("Backup size skips deleted tracked files, broken links, and the separately copied child", options, () => fixture((root) => {
  mkdirSync(path.join(root, "heavy-chain"));
  writeFileSync(path.join(root, "heavy-chain", "part"), "1234567");
  writeFileSync(path.join(root, "ordinary"), "123");
  writeFileSync(path.join(root, "deleted"), "1234");
  execFileSync("git", ["-C", root, "add", "deleted"]);
  unlinkSync(path.join(root, "deleted"));
  symlinkSync("absent", path.join(root, "broken"));
  assert.deepEqual(measure([{ label: "apparel-root", root }]), { total_bytes: 3, selected_files: 1 });
}));

test("Backup size permits the exact 100 MiB cap and reports oversize without file names", options, () => fixture((root) => {
  const file = path.join(root, "private-untracked-name");
  const fd = openSync(file, "w");
  try { ftruncateSync(fd, 104857600); } finally { closeSync(fd); }
  assert.equal(measure([{ label: "test", root }]).total_bytes, 104857600);
  const tooLarge = openSync(file, "r+");
  try { ftruncateSync(tooLarge, 104857601); } finally { closeSync(tooLarge); }
  const cli = spawnSync(process.execPath, [script, "104857600", "test", "--", root], { encoding: "utf8" });
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout, "");
  assert.equal(cli.stderr, "github_file_too_large:test\n");
  assert.doesNotMatch(cli.stderr, /private-untracked-name/);
}));

test("Backup size handles symlinks as links, not as the contents of their targets", options, () => fixture((root) => {
  writeFileSync(path.join(root, "target"), "12345");
  symlinkSync("target", path.join(root, "link"));
  assert.deepEqual(measure([{ label: "test", root }]), { total_bytes: 11, selected_files: 2 });
}));

test("Backup size fails unreadable repositories and the runner records the size-check blocker", options, () => {
  const cli = spawnSync(process.execPath, [script, "104857600", "test", "--", "/nonexistent/aos-backup-size-fixture"], { encoding: "utf8" });
  assert.equal(cli.status, 1);
  assert.equal(cli.stderr, "backup_size_read_failed\n");
  const runner = readFileSync(path.join(path.dirname(script), "run_daily_backup_snapshot.sh"), "utf8");
  const fn = runner.match(/^selected_bytes_total\(\) \{[\s\S]*?^\}/m)[0];
  assert.match(fn, /measure_selected_backup_bytes\.mjs/);
  assert.doesNotMatch(fn, /stat -f/);
  assert.match(runner, /selected_bytes_total 2>"\$ARTIFACT_DIR\/selected-size.err"/);
  assert.match(runner, /github_file_too_large:\*\|backup_size_\*\) fail "\$size_blocker"/);
});

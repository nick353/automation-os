import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { runObsidianIngest } from "../obsidian/ingest.js";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-obsidian-ingest-"));
const previousAllowCustomVault = process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT;
process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT = "1";

test.after(() => {
  if (previousAllowCustomVault === undefined) delete process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT;
  else process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT = previousAllowCustomVault;
});

test("Obsidian ingest writes safe frontmatter and fenced body to 09_Inbox", () => {
  const vaultPath = createVault("frontmatter-body");
  const result = runObsidianIngest({
    vaultPath,
    sourceUrl: "https://example.com/a?x=1:y#frag",
    sourceTitle: "Daily: AI / ../ capture",
    sourceType: "article:note",
    text: "frontmatter-like:\n---\nvalue: yes\n```\ninner fence\n```",
    capturedAt: "2026-06-14T00:00:00.000Z"
  });

  assert.equal(result.ok, true);
  assert.equal(result.file, join("09_Inbox", "Daily-AI-capture.md"));
  const markdown = readFileSync(result.path, "utf8");
  assert.match(markdown, /^---\nkind: inbox\nneeds_classification: yes\n/m);
  assert.match(markdown, /auto_process: obsidian_internal_only/);
  assert.match(markdown, /processing_status: queued/);
  assert.match(markdown, /suggested_destination: unknown/);
  assert.match(markdown, /source_url: "https:\/\/example\.com\/a\?x=1:y#frag"/);
  assert.match(markdown, /source_type: "article:note"/);
  assert.match(markdown, /capture_type: "article:note"/);
  assert.match(markdown, /source_title: "Daily: AI \/ \.\.\/ capture"/);
  assert.match(markdown, /captured_at: "2026-06-14T00:00:00.000Z"/);
  assert.match(markdown, /source_of_truth: "https:\/\/example\.com\/a\?x=1:y#frag"/);
  assert.match(markdown, /external_action_required: false/);
  assert.match(markdown, /approval_required: false/);
  assert.doesNotMatch(markdown, /generated_by:/);
  assert.match(markdown, /## Source Pointer/);
  assert.match(markdown, /## Content\n\n````text\nfrontmatter-like:/);
  assert.match(markdown, /\n````\n$/);
});

test("Obsidian ingest avoids filename collisions with numeric suffixes", () => {
  const vaultPath = createVault("collision");
  const first = runObsidianIngest({
    vaultPath,
    sourceTitle: "Collision Note",
    sourceType: "note",
    text: "first",
    capturedAt: "2026-06-14T01:00:00.000Z"
  });
  const second = runObsidianIngest({
    vaultPath,
    sourceTitle: "Collision Note",
    sourceType: "note",
    text: "second",
    capturedAt: "2026-06-14T01:01:00.000Z"
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.file, join("09_Inbox", "Collision-Note.md"));
  assert.equal(second.file, join("09_Inbox", "Collision-Note-2.md"));
  assert.match(readFileSync(second.path, "utf8"), /second/);
});

test("Obsidian ingest refuses custom vaults without explicit override", () => {
  const previousAllow = process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT;
  const vaultPath = createVault("custom-refused");
  process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT = "0";
  try {
    const result = runObsidianIngest({ vaultPath, sourceType: "note", text: "blocked" });
    assert.equal(result.ok, false);
    assert.equal(result.error, "obsidian_custom_export_requires_approval");
    assert.equal(existsSync(join(vaultPath, "09_Inbox", "note.md")), false);
  } finally {
    if (previousAllow === undefined) delete process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT;
    else process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT = previousAllow;
  }
});

test("Obsidian ingest refuses symlink 09_Inbox", () => {
  const vaultPath = createVault("symlink-inbox");
  const externalRoot = join(tempRoot, "external-inbox");
  mkdirSync(externalRoot, { recursive: true });
  writeFileSync(join(externalRoot, "Existing.md"), "external");
  rmSync(join(vaultPath, "09_Inbox"), { recursive: true, force: true });
  symlinkSync(externalRoot, join(vaultPath, "09_Inbox"));

  const result = runObsidianIngest({ vaultPath, sourceType: "note", text: "must not write" });

  assert.equal(result.ok, false);
  assert.equal(result.error, "obsidian_inbox_not_directory");
  assert.deepEqual(readFileSync(join(externalRoot, "Existing.md"), "utf8"), "external");
  assert.equal(existsSync(join(externalRoot, "note.md")), false);
});

test("Obsidian ingest CLI reads stdin and prints JSON", () => {
  const vaultPath = createVault("cli-stdin-json");
  const result = spawnSync(
    process.execPath,
    [
      join(process.cwd(), "apps/server/dist/cli/ingestObsidian.js"),
      `--vault=${vaultPath}`,
      "--source-url=https://example.com/stdin",
      "--source-title=CLI Source",
      "--source-type=web"
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT: "1"
      },
      input: "stdin body",
      encoding: "utf8"
    }
  );
  const body = JSON.parse(result.stdout) as { ok: boolean; file: string; path: string; sourceType: string };

  assert.equal(result.status, 0);
  assert.equal(body.ok, true);
  assert.equal(body.file, join("09_Inbox", "CLI-Source.md"));
  assert.equal(body.sourceType, "web");
  assert.match(readFileSync(body.path, "utf8"), /stdin body/);
});

function createVault(name: string): string {
  const vaultPath = join(tempRoot, name);
  mkdirSync(join(vaultPath, "09_Inbox"), { recursive: true });
  return vaultPath;
}

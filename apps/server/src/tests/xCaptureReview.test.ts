import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { runXCaptureReview, type XCaptureReviewResult } from "../obsidian/xCaptureReview.js";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-x-capture-review-"));
const previousAllowCustomVault = process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT;
process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT = "1";

function assertBlocked(result: XCaptureReviewResult): asserts result is Extract<XCaptureReviewResult, { ok: false }> {
  assert.equal(result.ok, false);
}

test.after(() => {
  if (previousAllowCustomVault === undefined) delete process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT;
  else process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT = previousAllowCustomVault;
});

test("X Capture Review writes JSON and generated queue from authenticated X capture notes", () => {
  const vaultPath = createVault("basic");
  const outputRoot = join(tempRoot, "basic-output");
  writeXCapture(
    vaultPath,
    "X-auth-capture-Claude-Code-agent-video-workflow.md",
    "Claude Code agent video workflow",
    "https://x.com/noirinvestor/status/2066779097485939131",
    "This Claude Code agent workflow shows stages, sub agents, orchestrator review gates, and proof checks."
  );
  writeXCapture(
    vaultPath,
    "X-auth-capture-Codex-Lab-article-link.md",
    "Codex Lab article link",
    "https://x.com/Gencoin8/status/2066776503975890962",
    "Agentmemory keeps persistent memory in markdown and compares MEMORY.md style context retrieval."
  );
  writeXCapture(
    vaultPath,
    "X-auth-capture-NotebookLM-Gemini-Obsidian-learning-workflow.md",
    "NotebookLM Gemini Obsidian learning workflow",
    "https://x.com/phosphenq/status/2026383675735048248",
    "NotebookLM, Gemini, and Obsidian are used for second brain summarization and duplicate detection."
  );

  const result = runXCaptureReview({ vaultPath, outputRoot, reviewedAt: "2026-06-16T12:00:00.000Z" });

  assert.equal(result.ok, true);
  assert.equal(result.scanned, 3);
  assert.equal(result.reviewed, 3);
  assert.equal(result.jsonPath, join(outputRoot, "review-20260616.json"));
  assert.equal(existsSync(result.jsonPath), true);
  assert.equal(existsSync(result.queuePath), true);
  assert.deepEqual(
    result.items.map((item) => item.category),
    ["agent_coordination", "memory_pattern", "obsidian_pattern"]
  );

  const queue = readFileSync(result.queuePath, "utf8");
  assert.match(queue, /generated_by: automation-os/);
  assert.match(queue, /# X Capture Review Queue/);
  assert.match(queue, /Ready To Promote/);
  assert.match(queue, /agent_coordination/);
  assert.match(queue, /memory_pattern/);
  assert.match(queue, /obsidian_pattern/);
  assert.match(queue, /does not fetch URLs, move notes, post, publish, send, submit, delete/);

  const json = JSON.parse(readFileSync(result.jsonPath, "utf8")) as {
    generatedBy: string;
    boundary: { externalFetch: boolean; post: boolean; move: boolean; delete: boolean; browserSessionChange: boolean };
    items: Array<{ category: string }>;
  };
  assert.equal(json.generatedBy, "automation-os-x-capture-review");
  assert.deepEqual(json.boundary, { externalFetch: false, post: false, move: false, delete: false, browserSessionChange: false });
  assert.equal(json.items.length, 3);
});

test("X Capture Review refuses to overwrite a handwritten queue note", () => {
  const vaultPath = createVault("non-generated-target");
  writeXCapture(vaultPath, "X-auth-capture-Agent.md", "Agent workflow", "https://x.com/a/status/1", "agent workflow");
  const target = join(vaultPath, "01_Control Panel", "X Capture Review Queue.md");
  writeFileSync(target, "# Handwritten queue\n");

  const result = runXCaptureReview({ vaultPath, outputRoot: join(tempRoot, "non-generated-output"), reviewedAt: "2026-06-16T12:05:00.000Z" });

  assertBlocked(result);
  assert.equal(result.error, "obsidian_x_capture_review_non_generated_target");
  assert.equal(readFileSync(target, "utf8"), "# Handwritten queue\n");
});

test("X Capture Review skips symlinked inbox files", () => {
  const vaultPath = createVault("symlink-skip");
  const external = join(tempRoot, "external-x-capture.md");
  writeFileSync(external, "# external\nAgentmemory external note.");
  symlinkSync(external, join(vaultPath, "09_Inbox", "X-auth-capture-Symlink.md"));

  const result = runXCaptureReview({ vaultPath, outputRoot: join(tempRoot, "symlink-output"), reviewedAt: "2026-06-16T12:10:00.000Z" });

  assert.equal(result.ok, true);
  assert.equal(result.scanned, 0);
  assert.equal(result.reviewed, 0);
});

test("X Capture Review CLI refuses custom vault without explicit export override", () => {
  const vaultPath = createVault("cli-refused");
  const result = spawnSync(process.execPath, [join(process.cwd(), "apps/server/dist/cli/xCaptureReview.js"), `--vault=${vaultPath}`], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT: "0"
    },
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /obsidian_custom_export_requires_approval/);
});

function createVault(name: string): string {
  const vaultPath = join(tempRoot, name);
  for (const folder of ["01_Control Panel", "09_Inbox"]) mkdirSync(join(vaultPath, folder), { recursive: true });
  return vaultPath;
}

function writeXCapture(vaultPath: string, filename: string, title: string, sourceUrl: string, body: string): string {
  const path = join(vaultPath, "09_Inbox", filename);
  writeFileSync(
    path,
    [
      "---",
      `title: ${JSON.stringify(title)}`,
      `source_title: ${JSON.stringify(title)}`,
      `source_url: ${JSON.stringify(sourceUrl)}`,
      "source_type: authenticated_browser_capture",
      "---",
      "",
      `# ${title}`,
      "",
      body,
      ""
    ].join("\n")
  );
  return path;
}

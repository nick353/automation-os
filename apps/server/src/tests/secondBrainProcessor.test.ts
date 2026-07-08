import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { runSecondBrainProcessor } from "../obsidian/secondBrainProcessor.js";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-second-brain-"));
const previousAllowCustomVault = process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT;
const previousProcessorStatusFile = process.env.AUTOMATION_OS_SECOND_BRAIN_PROCESSOR_STATUS_FILE;
const defaultProcessorStatusFile = join(process.cwd(), "data", "second-brain-processor-status.json");
const defaultProcessorStatusBefore = readOptionalText(defaultProcessorStatusFile);
const isolatedProcessorStatusFile = join(tempRoot, "default-second-brain-processor-status.json");
process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT = "1";
process.env.AUTOMATION_OS_SECOND_BRAIN_PROCESSOR_STATUS_FILE = isolatedProcessorStatusFile;

test.after(() => {
  assert.equal(readOptionalText(defaultProcessorStatusFile), defaultProcessorStatusBefore);
  if (previousAllowCustomVault === undefined) delete process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT;
  else process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT = previousAllowCustomVault;
  if (previousProcessorStatusFile === undefined) delete process.env.AUTOMATION_OS_SECOND_BRAIN_PROCESSOR_STATUS_FILE;
  else process.env.AUTOMATION_OS_SECOND_BRAIN_PROCESSOR_STATUS_FILE = previousProcessorStatusFile;
});

test("Second Brain processor dry-run leaves opted-in notes unchanged", () => {
  const vaultPath = createVault("dry-run");
  const notePath = writeNote(
    vaultPath,
    "09_Inbox",
    "Capture.md",
    "---\ntitle: Capture\nauto_process: obsidian_internal_only\nsuggested_destination: 06_Research\n---\n# Capture\n\nResearch note."
  );
  const before = readFileSync(notePath, "utf8");

  const result = runSecondBrainProcessor({ vaultPath, processedAt: "2026-06-14T00:00:00.000Z" });

  assert.equal(result.ok, true);
  assert.equal(result.apply, false);
  assert.equal(result.scanned, 1);
  assert.equal(result.eligible, 1);
  assert.equal(result.updated, 0);
  assert.equal(result.wouldUpdate, 1);
  assert.equal(result.statusFile, undefined);
  assert.equal(readFileSync(notePath, "utf8"), before);
});

test("Second Brain processor apply updates only explicit opt-in notes and preserves generated/non-opt-in notes", () => {
  const vaultPath = createVault("apply-explicit");
  const statusFile = join(tempRoot, "apply-explicit-status.json");
  const explicitPath = writeNote(
    vaultPath,
    "05_Projects",
    "Project.md",
    "---\ntitle: Project\nauto_process: obsidian_internal_only\nsuggested_destination: 05_Projects\n---\n# Project\n\nUse this for planning."
  );
  const explicitBefore = readFileSync(explicitPath, "utf8");
  const nonOptInPath = writeNote(vaultPath, "06_Research", "Plain.md", "---\ntitle: Plain\n---\n# Plain\n\nNo opt-in.");
  const generatedPath = writeNote(
    vaultPath,
    "09_Inbox",
    "Generated.md",
    "---\ntitle: Generated\ngenerated_by: automation-os\nauto_process: obsidian_internal_only\n---\n# Generated\n\nMust not change."
  );
  const nonOptInBefore = readFileSync(nonOptInPath, "utf8");
  const generatedBefore = readFileSync(generatedPath, "utf8");

  const result = runSecondBrainProcessor({ vaultPath, statusFile, apply: true, processedAt: "2026-06-14T01:00:00.000Z" });
  const updated = readFileSync(explicitPath, "utf8");

  assert.equal(result.ok, true);
  assert.equal(result.statusFile, statusFile);
  assert.equal(result.updated, 1);
  assert.equal(result.skipped, 2);
  assert.equal(result.blocked, 0);
  const updatedResult = result.results.find((item) => item.status === "updated");
  assert.ok(updatedResult?.backupFile);
  assert.equal(updatedResult.backupFile, ".backups/second-brain-processor/2026-06-14T01-00-00.000Z/05_Projects/Project.md");
  assert.equal(readFileSync(join(vaultPath, updatedResult.backupFile), "utf8"), explicitBefore);
  assert.match(updated, /processing_status: review_ready/);
  assert.match(updated, /processed_by: automation-os-second-brain-processor/);
  assert.match(updated, /processed_at: "2026-06-14T01:00:00.000Z"/);
  assert.match(updated, /# Project\n\nUse this for planning\./);
  assert.equal(readFileSync(nonOptInPath, "utf8"), nonOptInBefore);
  assert.equal(readFileSync(generatedPath, "utf8"), generatedBefore);
  assert.equal(existsSync(join(vaultPath, ".backups")), true);
  const status = JSON.parse(readFileSync(statusFile, "utf8"));
  assert.equal(status.updated, 1);
  assert.equal(status.results.find((item: { status: string }) => item.status === "updated")?.backupFile, updatedResult.backupFile);
});

test("Second Brain processor apply without explicit statusFile uses isolated test status file", () => {
  const vaultPath = createVault("apply-default-status-isolated");
  writeNote(
    vaultPath,
    "09_Inbox",
    "Default Status.md",
    "---\ntitle: Default Status\nauto_process: obsidian_internal_only\nsuggested_destination: 09_Inbox\n---\n# Default Status\n\nKeep default status isolated."
  );

  const result = runSecondBrainProcessor({ vaultPath, apply: true, processedAt: "2026-06-14T01:05:00.000Z" });
  const status = JSON.parse(readFileSync(isolatedProcessorStatusFile, "utf8")) as { statusFile: string; updated: number };

  assert.equal(result.ok, true);
  assert.equal(result.statusFile, isolatedProcessorStatusFile);
  assert.equal(status.statusFile, isolatedProcessorStatusFile);
  assert.equal(status.updated, 1);
  assert.equal(readOptionalText(defaultProcessorStatusFile), defaultProcessorStatusBefore);
});

test("Second Brain processor second apply is unchanged and does not create another backup", () => {
  const vaultPath = createVault("idempotent-second-apply");
  const statusFile = join(tempRoot, "idempotent-second-apply-status.json");
  const notePath = writeNote(
    vaultPath,
    "09_Inbox",
    "Stable.md",
    "---\ntitle: Stable\nauto_process: obsidian_internal_only\nsuggested_destination: 06_Research\n---\n# Stable\n\nResearch note."
  );

  const first = runSecondBrainProcessor({ vaultPath, statusFile, apply: true, processedAt: "2026-06-14T01:10:00.000Z" });
  const afterFirst = readFileSync(notePath, "utf8");
  const second = runSecondBrainProcessor({ vaultPath, statusFile, apply: true, processedAt: "2026-06-14T01:20:00.000Z" });
  const afterSecond = readFileSync(notePath, "utf8");

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.updated, 1);
  assert.equal(second.updated, 0);
  assert.equal(second.unchanged, 1);
  assert.equal(second.results[0]?.status, "unchanged");
  assert.equal(afterSecond, afterFirst);
  assert.match(afterSecond, /processed_at: "2026-06-14T01:10:00.000Z"/);
  assert.equal(existsSync(join(vaultPath, ".backups", "second-brain-processor", "2026-06-14T01-20-00.000Z")), false);
});

test("Second Brain processor blocks external or approval-required notes without changes", () => {
  const vaultPath = createVault("blocked");
  const externalPath = writeNote(
    vaultPath,
    "09_Inbox",
    "External.md",
    "---\ntitle: External\nauto_process: obsidian_internal_only\nexternal_action_required: true\n---\n# External\n\nNeeds external work."
  );
  const approvalPath = writeNote(
    vaultPath,
    "09_Inbox",
    "Approval.md",
    "---\ntitle: Approval\nauto_process: obsidian_internal_only\napproval_required: true\n---\n# Approval\n\nNeeds approval."
  );
  const externalBefore = readFileSync(externalPath, "utf8");
  const approvalBefore = readFileSync(approvalPath, "utf8");

  const result = runSecondBrainProcessor({ vaultPath, apply: true, processedAt: "2026-06-14T02:00:00.000Z" });

  assert.equal(result.ok, true);
  assert.equal(result.updated, 0);
  assert.equal(result.blocked, 2);
  assert.equal(readFileSync(externalPath, "utf8"), externalBefore);
  assert.equal(readFileSync(approvalPath, "utf8"), approvalBefore);
});

test("Second Brain processor treats inline-comment true flags as protected", () => {
  const vaultPath = createVault("inline-comment-guards");
  const workflowOwnedPath = writeNote(
    vaultPath,
    "09_Inbox",
    "Workflow Owned.md",
    "---\ntitle: Workflow Owned\nauto_process: obsidian_internal_only\nworkflow_owned: true # owned by a workflow\n---\n# Workflow Owned\n\nDo not change."
  );
  const approvalPath = writeNote(
    vaultPath,
    "09_Inbox",
    "Approval Inline.md",
    "---\ntitle: Approval Inline\nauto_process: obsidian_internal_only\napproval_required: true # user gate\n---\n# Approval Inline\n\nNeeds approval."
  );
  const generatedPath = writeNote(
    vaultPath,
    "09_Inbox",
    "Generated Inline.md",
    "---\ntitle: Generated Inline\ngenerated_by: automation-os # generated note\nauto_process: obsidian_internal_only\n---\n# Generated Inline\n\nGenerated."
  );
  const workflowOwnedBefore = readFileSync(workflowOwnedPath, "utf8");
  const approvalBefore = readFileSync(approvalPath, "utf8");
  const generatedBefore = readFileSync(generatedPath, "utf8");

  const result = runSecondBrainProcessor({ vaultPath, apply: true, processedAt: "2026-06-14T02:30:00.000Z" });

  assert.equal(result.ok, true);
  assert.equal(result.updated, 0);
  assert.equal(result.skipped, 2);
  assert.equal(result.blocked, 1);
  assert.equal(readFileSync(workflowOwnedPath, "utf8"), workflowOwnedBefore);
  assert.equal(readFileSync(approvalPath, "utf8"), approvalBefore);
  assert.equal(readFileSync(generatedPath, "utf8"), generatedBefore);
});

test("Second Brain processor normalizes invalid suggested destinations to unknown", () => {
  const vaultPath = createVault("invalid-destination");
  const notePath = writeNote(
    vaultPath,
    "09_Inbox",
    "Invalid.md",
    "---\ntitle: Invalid\nneeds_classification: true\nsuggested_destination: ../../Secrets\n---\n# Invalid\n\nClassify carefully."
  );

  const result = runSecondBrainProcessor({ vaultPath, apply: true, processedAt: "2026-06-14T03:00:00.000Z" });
  const updated = readFileSync(notePath, "utf8");

  assert.equal(result.ok, true);
  assert.equal(result.updated, 1);
  assert.equal(result.results[0]?.suggestedDestination, "unknown");
  assert.match(updated, /suggested_destination: unknown/);
  assert.doesNotMatch(updated, /\.\.\/\.\.\/Secrets/);
});

test("Second Brain processor preserves invalid destination unknown on second apply", () => {
  const vaultPath = createVault("invalid-destination-second-apply");
  const notePath = writeNote(
    vaultPath,
    "09_Inbox",
    "Invalid Research.md",
    [
      "---",
      "title: Invalid Research",
      "needs_classification: true",
      "suggested_destination: ../../Secrets",
      "---",
      "# Invalid Research",
      "",
      "## Content",
      "",
      "```text",
      "This research note compares source-backed papers and would otherwise infer as research.",
      "```",
      ""
    ].join("\n")
  );

  const first = runSecondBrainProcessor({ vaultPath, apply: true, processedAt: "2026-06-14T03:01:00.000Z" });
  const afterFirst = readFileSync(notePath, "utf8");
  const second = runSecondBrainProcessor({ vaultPath, apply: true, processedAt: "2026-06-14T03:02:00.000Z" });
  const afterSecond = readFileSync(notePath, "utf8");

  assert.equal(first.ok, true);
  assert.equal(first.updated, 1);
  assert.equal(first.results[0]?.suggestedDestination, "unknown");
  assert.equal(second.ok, true);
  assert.equal(second.updated, 0);
  assert.equal(second.unchanged, 1);
  assert.equal(second.results[0]?.status, "unchanged");
  assert.equal(second.results[0]?.suggestedDestination, "unknown");
  assert.equal(afterSecond, afterFirst);
  assert.match(afterSecond, /suggested_destination: unknown/);
  assert.match(afterSecond, /processed_at: "2026-06-14T03:01:00.000Z"/);
  assert.equal(existsSync(join(vaultPath, ".backups", "second-brain-processor", "2026-06-14T03-02-00.000Z")), false);
});

test("Second Brain processor removes stale camelCase destination aliases", () => {
  const vaultPath = createVault("camelcase-invalid-destination-cleanup");
  const notePath = writeNote(
    vaultPath,
    "09_Inbox",
    "Camel Alias.md",
    [
      "---",
      "title: Camel Alias",
      "needs_classification: true",
      "suggestedDestination: ../../Secrets",
      "nextUse: Review and classify.",
      "unresolvedQuestion: Camel Alias",
      "reviewCycle: Review and classify.",
      "externalActionRequired: false",
      "approvalRequired: false",
      "---",
      "# Camel Alias",
      "",
      "Classify carefully."
    ].join("\n")
  );

  const result = runSecondBrainProcessor({ vaultPath, apply: true, processedAt: "2026-06-14T03:05:00.000Z" });
  const updated = readFileSync(notePath, "utf8");

  assert.equal(result.ok, true);
  assert.equal(result.updated, 1);
  assert.equal(result.results[0]?.suggestedDestination, "unknown");
  assert.match(updated, /suggested_destination: unknown/);
  assert.match(updated, /next_use:/);
  assert.match(updated, /unresolved_question:/);
  assert.match(updated, /review_cycle:/);
  assert.match(updated, /external_action_required: false/);
  assert.match(updated, /approval_required: false/);
  assert.doesNotMatch(updated, /^suggestedDestination:/m);
  assert.doesNotMatch(updated, /^nextUse:/m);
  assert.doesNotMatch(updated, /^unresolvedQuestion:/m);
  assert.doesNotMatch(updated, /^reviewCycle:/m);
  assert.doesNotMatch(updated, /^externalActionRequired:/m);
  assert.doesNotMatch(updated, /^approvalRequired:/m);
  assert.doesNotMatch(updated, /\.\.\/\.\.\/Secrets/);
});

test("Second Brain processor canonicalizes camelCase source pointers", () => {
  const vaultPath = createVault("camelcase-source-pointer-canonical");
  const notePath = writeNote(
    vaultPath,
    "09_Inbox",
    "Camel Source.md",
    [
      "---",
      "title: Camel Source",
      "needs_classification: true",
      "suggested_destination: unknown",
      'sourceUrl: "https://example.com/source"',
      'sourceOfTruth: "https://example.com/source#truth"',
      "---",
      "# Camel Source",
      "",
      "## Content",
      "",
      "```text",
      "Source-backed article capture for later research.",
      "```",
      ""
    ].join("\n")
  );

  const result = runSecondBrainProcessor({ vaultPath, apply: true, processedAt: "2026-06-14T03:06:00.000Z" });
  const updated = readFileSync(notePath, "utf8");

  assert.equal(result.ok, true);
  assert.equal(result.updated, 1);
  assert.match(updated, /source_url: "https:\/\/example\.com\/source"/);
  assert.match(updated, /source_of_truth: "https:\/\/example\.com\/source#truth"/);
  assert.doesNotMatch(updated, /^sourceUrl:/m);
  assert.doesNotMatch(updated, /^sourceOfTruth:/m);
});

test("Second Brain processor enriches X authenticated capture placeholders from observed content", () => {
  const vaultPath = createVault("x-auth-placeholder-enrichment");
  const notePath = writeNote(
    vaultPath,
    "09_Inbox",
    "AI Research Thread X.md",
    [
      "---",
      "kind: inbox",
      "needs_classification: yes",
      "auto_process: obsidian_internal_only",
      "processing_status: queued",
      "suggested_destination: unknown",
      'source_url: "https://x.com/example/status/123"',
      'source_type: "authenticated_browser_capture"',
      'capture_type: "authenticated_browser_capture"',
      'source_title: "AI Research Thread / X"',
      'source_of_truth: "https://x.com/example/status/123"',
      "progressive_summary: AI Research Thread / X",
      "distillation: AI Research Thread / X",
      "next_use: Review and classify.",
      "unresolved_question: AI Research Thread / X",
      "review_cycle: Review and classify.",
      "external_action_required: false",
      "approval_required: false",
      "---",
      "# AI Research Thread / X",
      "",
      "## Source Pointer",
      "",
      "- Source URL: https://x.com/example/status/123",
      "- Source type: `authenticated_browser_capture`",
      "",
      "## Content",
      "",
      "```text",
      "Capture ID: x-auth-20260614T031000Z",
      "Lane: x-learning",
      "Artifact directory: /tmp/automation-os/x-auth-20260614T031000Z",
      "",
      "AI research teams are using authenticated social captures as source-backed context for synthesis.",
      "Question: Which sources should be reviewed next?",
      "```",
      ""
    ].join("\n")
  );

  const result = runSecondBrainProcessor({ vaultPath, apply: true, processedAt: "2026-06-14T03:10:00.000Z" });
  const updated = readFileSync(notePath, "utf8");
  const second = runSecondBrainProcessor({ vaultPath, apply: true, processedAt: "2026-06-14T03:11:00.000Z" });
  const afterSecond = readFileSync(notePath, "utf8");

  assert.equal(result.ok, true);
  assert.equal(result.updated, 1);
  assert.equal(result.results[0]?.suggestedDestination, "06_Research");
  assert.match(updated, /suggested_destination: 06_Research/);
  assert.match(updated, /progressive_summary: AI research teams are using authenticated social captures as source-backed context for synthesis\./);
  assert.match(updated, /distillation: AI research teams are using authenticated social captures as source-backed context for synthesis\./);
  assert.match(updated, /next_use: "Use as research context: AI research teams are using authenticated social captures as source-backed context for synthesis\."/);
  assert.doesNotMatch(updated, /progressive_summary: Capture ID:/);
  assert.doesNotMatch(updated, /distillation: Capture ID:/);
  assert.doesNotMatch(updated, /next_use: "Use as research context: Capture ID:/);
  assert.match(updated, /unresolved_question: Which sources should be reviewed next\?/);
  assert.match(updated, /review_cycle: weekly/);
  assert.match(updated, /source_url: "https:\/\/x\.com\/example\/status\/123"/);
  assert.match(updated, /source_of_truth: "https:\/\/x\.com\/example\/status\/123"/);
  assert.match(updated, /## Content\n\n```text\nCapture ID: x-auth-20260614T031000Z/);
  assert.match(updated, /AI research teams are using authenticated social captures/);
  assert.doesNotMatch(updated, /progressive_summary: AI Research Thread \/ X/);
  assert.doesNotMatch(updated, /next_use: Review and classify\./);
  assert.equal(second.ok, true);
  assert.equal(second.updated, 0);
  assert.equal(second.unchanged, 1);
  assert.equal(second.results[0]?.status, "unchanged");
  assert.equal(second.results[0]?.suggestedDestination, "06_Research");
  assert.equal(afterSecond, updated);
  assert.match(afterSecond, /processed_at: "2026-06-14T03:10:00.000Z"/);
  assert.equal(existsSync(join(vaultPath, ".backups", "second-brain-processor", "2026-06-14T03-11-00.000Z")), false);
});

test("Second Brain processor legacy processed unknown with placeholder metadata can infer destination", () => {
  const vaultPath = createVault("legacy-processed-unknown-placeholder-infers");
  const notePath = writeNote(
    vaultPath,
    "09_Inbox",
    "Legacy AI Research Thread X.md",
    [
      "---",
      "kind: inbox",
      "needs_classification: yes",
      "auto_process: obsidian_internal_only",
      "processing_status: review_ready",
      "suggested_destination: unknown",
      'source_url: "https://x.com/example/status/789"',
      'source_type: "authenticated_browser_capture"',
      'capture_type: "authenticated_browser_capture"',
      'source_title: "Legacy AI Research Thread / X"',
      'source_of_truth: "https://x.com/example/status/789"',
      "progressive_summary: Legacy AI Research Thread / X",
      "distillation: Legacy AI Research Thread / X",
      "next_use: Review and classify.",
      "unresolved_question: Legacy AI Research Thread / X",
      "review_cycle: Review and classify.",
      "external_action_required: false",
      "approval_required: false",
      "processed_by: automation-os-second-brain-processor",
      'processed_at: "2026-06-14T03:09:00.000Z"',
      "---",
      "# Legacy AI Research Thread / X",
      "",
      "## Source Pointer",
      "",
      "- Source URL: https://x.com/example/status/789",
      "- Source type: `authenticated_browser_capture`",
      "",
      "## Content",
      "",
      "```text",
      "Capture ID: x-auth-20260614T031200Z",
      "Lane: x-learning",
      "Artifact directory: /tmp/automation-os/x-auth-20260614T031200Z",
      "",
      "AI research teams are comparing source-backed social captures with paper notes for synthesis.",
      "Question: Which capture should become the durable research source?",
      "```",
      ""
    ].join("\n")
  );

  const result = runSecondBrainProcessor({ vaultPath, apply: true, processedAt: "2026-06-14T03:12:00.000Z" });
  const updated = readFileSync(notePath, "utf8");

  assert.equal(result.ok, true);
  assert.equal(result.updated, 1);
  assert.equal(result.results[0]?.suggestedDestination, "06_Research");
  assert.match(updated, /suggested_destination: 06_Research/);
  assert.match(updated, /progressive_summary: AI research teams are comparing source-backed social captures with paper notes for synthesis\./);
  assert.match(updated, /next_use: "Use as research context: AI research teams are comparing source-backed social captures with paper notes for synthesis\."/);
  assert.doesNotMatch(updated, /progressive_summary: Capture ID:/);
  assert.doesNotMatch(updated, /next_use: "Use as research context: Capture ID:/);
  assert.match(updated, /unresolved_question: Which capture should become the durable research source\?/);
  assert.match(updated, /processed_at: "2026-06-14T03:12:00.000Z"/);
  assert.doesNotMatch(updated, /progressive_summary: Legacy AI Research Thread \/ X/);
  assert.doesNotMatch(updated, /next_use: Review and classify\./);
});

test("Second Brain processor regenerates existing capture evidence review metadata", () => {
  const vaultPath = createVault("existing-capture-evidence-metadata");
  const notePath = writeNote(
    vaultPath,
    "09_Inbox",
    "Existing Capture Evidence Metadata.md",
    [
      "---",
      "kind: inbox",
      "needs_classification: yes",
      "auto_process: obsidian_internal_only",
      "processing_status: review_ready",
      "suggested_destination: unknown",
      'source_url: "https://x.com/example/status/987"',
      'source_type: "authenticated_browser_capture"',
      'capture_type: "authenticated_browser_capture"',
      'source_title: "Existing Capture Evidence Metadata / X"',
      'source_of_truth: "https://x.com/example/status/987"',
      "progressive_summary: Capture ID: x-auth-20260614T031500Z",
      "distillation: Artifact directory: /tmp/automation-os/x-auth-20260614T031500Z",
      'next_use: "Use as research context: Capture ID: x-auth-20260614T031500Z"',
      "unresolved_question: none",
      "review_cycle: weekly",
      "external_action_required: false",
      "approval_required: false",
      "processed_by: automation-os-second-brain-processor",
      'processed_at: "2026-06-14T03:14:00.000Z"',
      "---",
      "# Existing Capture Evidence Metadata / X",
      "",
      "## Content",
      "",
      "```text",
      "Capture ID: x-auth-20260614T031500Z",
      "Lane: x-learning",
      "Artifact directory: /tmp/automation-os/x-auth-20260614T031500Z",
      "",
      "Research teams are turning authenticated X captures into reusable source-backed synthesis notes.",
      "Question: Which research thread should anchor the weekly synthesis?",
      "```",
      ""
    ].join("\n")
  );

  const result = runSecondBrainProcessor({ vaultPath, apply: true, processedAt: "2026-06-14T03:15:00.000Z" });
  const updated = readFileSync(notePath, "utf8");

  assert.equal(result.ok, true);
  assert.equal(result.updated, 1);
  assert.equal(result.results[0]?.suggestedDestination, "06_Research");
  assert.match(updated, /suggested_destination: 06_Research/);
  assert.match(updated, /progressive_summary: Research teams are turning authenticated X captures into reusable source-backed synthesis notes\./);
  assert.match(updated, /distillation: Research teams are turning authenticated X captures into reusable source-backed synthesis notes\./);
  assert.match(updated, /next_use: "Use as research context: Research teams are turning authenticated X captures into reusable source-backed synthesis notes\."/);
  assert.doesNotMatch(updated, /progressive_summary: Capture ID:/);
  assert.doesNotMatch(updated, /distillation: Artifact directory:/);
  assert.doesNotMatch(updated, /next_use: "Use as research context: Capture ID:/);
  assert.match(updated, /unresolved_question: none/);
  assert.match(updated, /review_cycle: weekly/);
  assert.match(updated, /processed_at: "2026-06-14T03:15:00.000Z"/);
});

test("Second Brain processor preserves valid suggested destination over inferred signals", () => {
  const vaultPath = createVault("valid-destination-preserved");
  const notePath = writeNote(
    vaultPath,
    "09_Inbox",
    "Runbook Capture.md",
    "---\ntitle: Runbook Capture\nneeds_classification: true\nsuggested_destination: 08_Runbooks\nsource_type: authenticated_browser_capture\nsource_url: \"https://x.com/example/status/456\"\n---\n# Runbook Capture\n\n## Content\n\n```text\nThis article compares research papers and should otherwise look like research.\n```"
  );

  const result = runSecondBrainProcessor({ vaultPath, apply: true, processedAt: "2026-06-14T03:15:00.000Z" });
  const updated = readFileSync(notePath, "utf8");

  assert.equal(result.ok, true);
  assert.equal(result.updated, 1);
  assert.equal(result.results[0]?.suggestedDestination, "08_Runbooks");
  assert.match(updated, /suggested_destination: 08_Runbooks/);
  assert.match(updated, /next_use: "Use as operational guidance: This article compares research papers and should otherwise look like research\."/);
});

test("Second Brain processor preserves non-placeholder review metadata", () => {
  const vaultPath = createVault("non-placeholder-preserved");
  const notePath = writeNote(
    vaultPath,
    "06_Research",
    "Stable Research.md",
    [
      "---",
      "title: Stable Research",
      "auto_process: obsidian_internal_only",
      "suggested_destination: 06_Research",
      "progressive_summary: Keep this exact summary.",
      "distillation: Keep this distilled lesson.",
      "next_use: Use for monthly strategy review.",
      "unresolved_question: Which team owns follow-up?",
      "review_cycle: quarterly",
      "---",
      "# Stable Research",
      "",
      "## Content",
      "",
      "```text",
      "New body text should not overwrite curated metadata.",
      "```",
      ""
    ].join("\n")
  );

  const result = runSecondBrainProcessor({ vaultPath, apply: true, processedAt: "2026-06-14T03:20:00.000Z" });
  const updated = readFileSync(notePath, "utf8");

  assert.equal(result.ok, true);
  assert.equal(result.updated, 1);
  assert.match(updated, /progressive_summary: Keep this exact summary\./);
  assert.match(updated, /distillation: Keep this distilled lesson\./);
  assert.match(updated, /next_use: Use for monthly strategy review\./);
  assert.match(updated, /unresolved_question: Which team owns follow-up\?/);
  assert.match(updated, /review_cycle: quarterly/);
});

test("Second Brain processor does not follow symlink files or directories outside the vault", () => {
  const vaultPath = createVault("symlink-escape");
  const externalRoot = join(tempRoot, "external-second-brain");
  mkdirSync(externalRoot, { recursive: true });
  const externalFile = join(externalRoot, "External.md");
  writeFileSync(
    externalFile,
    "---\ntitle: External\nauto_process: obsidian_internal_only\nsuggested_destination: 06_Research\n---\n# External\n\nOutside vault.\n"
  );
  symlinkSync(externalFile, join(vaultPath, "09_Inbox", "Linked External.md"));
  symlinkSync(externalRoot, join(vaultPath, "09_Inbox", "Linked Dir"));
  const before = readFileSync(externalFile, "utf8");

  const result = runSecondBrainProcessor({ vaultPath, apply: true, processedAt: "2026-06-14T03:30:00.000Z" });

  assert.equal(result.ok, true);
  assert.equal(result.updated, 0);
  assert.equal(result.scanned, 0);
  assert.equal(result.blocked, 0);
  assert.equal(readFileSync(externalFile, "utf8"), before);
  assert.equal(existsSync(join(vaultPath, ".backups")), false);
});

test("Second Brain processor does not scan when a target folder is an external symlink", () => {
  const vaultPath = createVault("target-folder-symlink");
  const externalRoot = join(tempRoot, "external-target-folder");
  mkdirSync(externalRoot, { recursive: true });
  const externalFile = join(externalRoot, "External Inbox.md");
  writeFileSync(
    externalFile,
    "---\ntitle: External Inbox\nauto_process: obsidian_internal_only\nsuggested_destination: 06_Research\n---\n# External Inbox\n\nOutside target folder.\n"
  );
  rmSync(join(vaultPath, "09_Inbox"), { recursive: true, force: true });
  symlinkSync(externalRoot, join(vaultPath, "09_Inbox"));
  const before = readFileSync(externalFile, "utf8");

  const result = runSecondBrainProcessor({ vaultPath, apply: true, processedAt: "2026-06-14T03:40:00.000Z" });

  assert.equal(result.ok, true);
  assert.equal(result.scanned, 0);
  assert.equal(result.eligible, 0);
  assert.equal(result.updated, 0);
  assert.equal(result.blocked, 0);
  assert.deepEqual(result.results, []);
  assert.equal(readFileSync(externalFile, "utf8"), before);
  assert.equal(existsSync(join(vaultPath, ".backups")), false);
});

test("Second Brain processor blocks apply against explicit custom vault without explicit export override", () => {
  const previousAllow = process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT;
  const vaultPath = createVault("processor-explicit-custom-refused");
  const notePath = writeNote(
    vaultPath,
    "09_Inbox",
    "Explicit Apply.md",
    "---\ntitle: Explicit Apply\nauto_process: obsidian_internal_only\n---\n# Explicit Apply\n\nMust stay unchanged."
  );
  const before = readFileSync(notePath, "utf8");
  process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT = "0";

  try {
    const result = runSecondBrainProcessor({ apply: true, vaultPath, processedAt: "2026-06-14T03:50:00.000Z" });

    assert.equal(result.ok, false);
    assert.equal(result.apply, true);
    assert.equal(result.vaultPath, vaultPath);
    assert.equal(result.scanned, 0);
    assert.equal(result.eligible, 0);
    assert.equal(result.updated, 0);
    assert.equal(result.wouldUpdate, 0);
    assert.equal(result.unchanged, 0);
    assert.equal(result.skipped, 0);
    assert.equal(result.blocked, 1);
    assert.deepEqual(result.results, [{ file: ".", status: "blocked", reason: "obsidian_custom_export_requires_approval" }]);
    assert.equal(readFileSync(notePath, "utf8"), before);
    assert.equal(existsSync(join(vaultPath, ".backups")), false);
  } finally {
    if (previousAllow === undefined) delete process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT;
    else process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT = previousAllow;
  }
});


test("Second Brain CLI refuses custom vault without explicit export override", () => {
  const vaultPath = createVault("cli-custom-refused");
  const result = spawnSync(process.execPath, [join(process.cwd(), "apps/server/dist/cli/secondBrainProcess.js"), `--vault=${vaultPath}`], {
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

test("Second Brain CLI refuses custom vault from environment without explicit export override", () => {
  const vaultPath = createVault("cli-env-custom-refused");
  const result = spawnSync(process.execPath, [join(process.cwd(), "apps/server/dist/cli/secondBrainProcess.js")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AUTOMATION_OS_OBSIDIAN_VAULT: vaultPath,
      AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT: "0"
    },
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /obsidian_custom_export_requires_approval/);
});

test("Second Brain processor blocks apply against custom env vault without explicit export override", () => {
  const previousVault = process.env.AUTOMATION_OS_OBSIDIAN_VAULT;
  const previousAllow = process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT;
  const vaultPath = createVault("processor-env-custom-refused");
  const notePath = writeNote(
    vaultPath,
    "09_Inbox",
    "Env Apply.md",
    "---\ntitle: Env Apply\nauto_process: obsidian_internal_only\n---\n# Env Apply\n\nMust stay unchanged."
  );
  const before = readFileSync(notePath, "utf8");
  process.env.AUTOMATION_OS_OBSIDIAN_VAULT = vaultPath;
  process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT = "0";

  try {
    const result = runSecondBrainProcessor({ apply: true, processedAt: "2026-06-14T04:00:00.000Z" });

    assert.equal(result.ok, false);
    assert.equal(result.updated, 0);
    assert.equal(result.blocked, 1);
    assert.equal(result.results[0]?.reason, "obsidian_custom_export_requires_approval");
    assert.equal(readFileSync(notePath, "utf8"), before);
  } finally {
    if (previousVault === undefined) delete process.env.AUTOMATION_OS_OBSIDIAN_VAULT;
    else process.env.AUTOMATION_OS_OBSIDIAN_VAULT = previousVault;
    if (previousAllow === undefined) delete process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT;
    else process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT = previousAllow;
  }
});

function createVault(name: string): string {
  const vaultPath = join(tempRoot, name);
  for (const folder of ["05_Projects", "06_Research", "07_Decisions", "08_Runbooks", "09_Inbox"]) {
    mkdirSync(join(vaultPath, folder), { recursive: true });
  }
  return vaultPath;
}

function writeNote(vaultPath: string, folder: string, filename: string, markdown: string): string {
  const path = join(vaultPath, folder, filename);
  writeFileSync(path, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
  return path;
}

function readOptionalText(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

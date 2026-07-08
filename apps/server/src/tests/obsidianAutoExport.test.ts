import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

type RowLike = Record<string, any>;

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-obsidian-status-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");
process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT = "1";

const db = await import("../db/client.js");

test("Obsidian auto export status is persisted and restored", async () => {
  db.initDb();
  db.resetDemoData();
  const statusFile = join(tempRoot, "status", "obsidian-export-status.json");
  process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE = statusFile;
  const docsDir = join(tempRoot, "docs");
  const vaultPath = join(tempRoot, "vault");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "00-vision.md"), "# Vision\n\nPersistent status.");

  const firstModule = await import(`../obsidian/autoExport.js?status-write=${Date.now()}`);
  const written = firstModule.runObsidianExportNow("test_persisted_status", { vaultPath, docsDir });

  assert.equal(written.ok, true);
  assert.ok(written.lastSuccessAt);
  assert.equal(existsSync(statusFile), true);

  const restoredModule = await import(`../obsidian/autoExport.js?status-read=${Date.now()}`);
  const restored = restoredModule.getObsidianExportStatus();

  assert.equal(restored.ok, true);
  assert.equal(restored.lastSuccessAt, written.lastSuccessAt);
  assert.equal(restored.vaultPath, written.vaultPath);
  assert.equal(restored.outputDir, written.outputDir);
  assert.equal(restored.reason, "test_persisted_status");
  assert.deepEqual(restored.secondBrainFiles, written.secondBrainFiles);
  assert.equal(restored.generatedFileCheck.ok, true);
  assert.equal(restored.generatedFileCheck.checkedAt, written.lastSuccessAt);
  assert.equal(restored.generatedFileCheck.total, written.generatedFileCheck.total);
  assert.equal(restored.generatedFileCheck.missing.length, 0);
  assert.equal(restored.generatedFileCheck.nonGenerated.length, 0);
  assert.ok(restored.generatedFileCheck.files.some((file: RowLike) => file.path.endsWith("Resume Current Work.md") && file.marker === "frontmatter"));
  assert.ok(restored.generatedFileCheck.files.some((file: RowLike) => file.path.endsWith("Action Queue.base") && file.marker === "comment"));
  assert.ok(
    restored.generatedFileCheck.files.some(
      (file: RowLike) => file.path.endsWith("resume-contract.json") && file.marker === "not_applicable" && file.generated === "not_applicable"
    )
  );
  assert.equal(restored.secondBrainFiles.length, 3);
  assert.ok(restored.secondBrainFiles.some((file: string) => file.endsWith(join("01_Control Panel", "Second Brain Intake.md"))));
  assert.ok(restored.secondBrainFiles.some((file: string) => file.endsWith(join("01_Control Panel", "Second Brain Auto Processor.md"))));
  assert.ok(restored.secondBrainFiles.some((file: string) => file.endsWith(join("00_Start Here", "Second Brain Weekly Digest.md"))));
  assert.equal(restored.dashboardFiles.length, 7);
  assert.ok(restored.dashboardFiles.some((file: string) => file.endsWith(join("10_Dashboards", "Second Brain Review.base"))));
  assert.ok(restored.dashboardFiles.some((file: string) => file.endsWith(join("10_Dashboards", "Blocker Radar.md"))));
  assert.ok(restored.dashboardFiles.some((file: string) => file.endsWith(join("10_Dashboards", "Success Paths.md"))));
  assert.ok(restored.secondBrainPolicy.autoApprovedScopes.includes("obsidian_internal_distill"));
  assert.deepEqual(restored.secondBrainPolicy.approvalRequiredScopes, ["billing_purchase_payment_checkout"]);
  assert.equal(restored.proofInboxFile?.endsWith(join("04_Proof Pointers", "Proof Inbox.md")), true);
});

test("Obsidian generated file check records missing, non-generated, and JSON not-applicable files", async () => {
  const statusFile = join(tempRoot, "generated-file-check", "obsidian-export-status.json");
  const checkRoot = join(tempRoot, "generated-file-check-files");
  mkdirSync(checkRoot, { recursive: true });
  process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE = statusFile;
  process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT = "1";
  const generatedMarkdown = join(checkRoot, "Generated.md");
  const nonGeneratedMarkdown = join(checkRoot, "Manual.md");
  const generatedBase = join(checkRoot, "Queue.base");
  const jsonFile = join(checkRoot, "resume-contract.json");
  const missingFile = join(checkRoot, "Missing.md");
  writeFileSync(generatedMarkdown, "---\ngenerated_by: automation-os\n---\n\n# Generated\n");
  writeFileSync(nonGeneratedMarkdown, "---\nsystem: personal\n---\n\n# Manual\n");
  writeFileSync(generatedBase, "# generated_by: automation-os\nviews:\n");
  writeFileSync(jsonFile, JSON.stringify({ readFirst: [] }, null, 2));

  const autoExport = await import(`../obsidian/autoExport.js?generated-file-check=${Date.now()}`);
  const status = autoExport.runObsidianExportAttemptForTest("generated_file_check", () => ({
    vaultPath: checkRoot,
    outputDir: checkRoot,
    files: [generatedMarkdown, nonGeneratedMarkdown],
    runs: 0,
    proofs: 0,
    docs: 0,
    controlPanelFile: null,
    proofInboxFile: null,
    resumeContractFile: null,
    resumeContractJsonFile: jsonFile,
    missionFiles: [missingFile],
    secondBrainFiles: [],
    dashboardFiles: [generatedBase],
    orientationFiles: [],
    templateFiles: []
  }));
  const persisted = JSON.parse(readFileSync(statusFile, "utf8")) as RowLike;

  assert.equal(status.ok, true);
  assert.equal(status.generatedFileCheck.ok, false);
  assert.equal(status.generatedFileCheck.total, 5);
  assert.deepEqual(status.generatedFileCheck.missing, [missingFile]);
  assert.deepEqual(status.generatedFileCheck.nonGenerated, [nonGeneratedMarkdown]);
  assert.ok(status.generatedFileCheck.files.some((file: RowLike) => file.path === jsonFile && file.marker === "not_applicable"));
  assert.deepEqual(persisted.generatedFileCheck.missing, [missingFile]);
  assert.deepEqual(persisted.generatedFileCheck.nonGenerated, [nonGeneratedMarkdown]);
});

test("Obsidian auto export status refreshes external persisted updates", async () => {
  db.initDb();
  db.resetDemoData();
  const statusFile = join(tempRoot, "external-refresh", "obsidian-export-status.json");
  process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE = statusFile;
  process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT = "1";
  const docsDir = join(tempRoot, "external-refresh-docs");
  const vaultPath = join(tempRoot, "external-refresh-vault");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "00-vision.md"), "# Vision\n\nExternal status refresh.");

  const autoExport = await import(`../obsidian/autoExport.js?status-external-refresh=${Date.now()}`);
  const written = autoExport.runObsidianExportNow("initial_auto_export", { vaultPath, docsDir });
  const persisted = JSON.parse(readFileSync(statusFile, "utf8")) as Record<string, unknown>;
  writeFileSync(statusFile, JSON.stringify({ ...persisted, enabled: false, reason: "codex_stop_hook" }, null, 2));

  const refreshed = autoExport.getObsidianExportStatus();

  assert.equal(written.reason, "initial_auto_export");
  assert.equal(refreshed.reason, "codex_stop_hook");
  assert.equal(refreshed.lastSuccessAt, written.lastSuccessAt);
  assert.equal(refreshed.enabled, true);
});

test("Obsidian auto export status restores Second Brain review metadata from persisted JSON", async () => {
  const statusFile = join(tempRoot, "second-brain-review-metadata", "obsidian-export-status.json");
  mkdirSync(join(tempRoot, "second-brain-review-metadata"), { recursive: true });
  process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE = statusFile;
  process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT = "1";
  writeFileSync(
    statusFile,
    JSON.stringify(
      {
        ok: true,
        lastSuccessAt: "2026-06-14T00:00:00.000Z",
        secondBrainReviewMetadata: {
          auto_process: "obsidian_internal_only",
          processing_status: "in_progress",
          suggested_destination: "06_Research",
          progressive_summary: "Normalized and ready for distillation.",
          source_of_truth: "redacted handwritten note",
          external_action_required: true,
          approval_required: true
        }
      },
      null,
      2
    )
  );

  const autoExport = await import(`../obsidian/autoExport.js?status-second-brain-review=${Date.now()}`);
  const restored = autoExport.getObsidianExportStatus();

  assert.deepEqual(restored.secondBrainReviewMetadata, {
    auto_process: "obsidian_internal_only",
    processing_status: "in_progress",
    suggested_destination: "06_Research",
    progressive_summary: "Normalized and ready for distillation.",
    source_of_truth: "redacted handwritten note",
    external_action_required: true,
    approval_required: true
  });
});

test("Obsidian auto export status defaults missing Second Brain review metadata for old JSON", async () => {
  const statusFile = join(tempRoot, "old-second-brain-review-metadata", "obsidian-export-status.json");
  mkdirSync(join(tempRoot, "old-second-brain-review-metadata"), { recursive: true });
  process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE = statusFile;
  process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT = "1";
  writeFileSync(statusFile, JSON.stringify({ ok: true, lastSuccessAt: "2026-06-14T00:00:00.000Z" }, null, 2));

  const autoExport = await import(`../obsidian/autoExport.js?status-old-second-brain-review=${Date.now()}`);
  const restored = autoExport.getObsidianExportStatus();

  assert.deepEqual(restored.secondBrainReviewMetadata, {
    auto_process: "obsidian_internal_only",
    processing_status: "queued",
    suggested_destination: "unknown",
    progressive_summary: "",
    source_of_truth: "handwritten Obsidian note",
    external_action_required: false,
    approval_required: false
  });
});

test("Obsidian export attempts preserve restored Second Brain review metadata", async () => {
  db.initDb();
  db.resetDemoData();
  const statusFile = join(tempRoot, "preserve-second-brain-review-metadata", "obsidian-export-status.json");
  const docsDir = join(tempRoot, "preserve-second-brain-review-metadata-docs");
  const vaultPath = join(tempRoot, "preserve-second-brain-review-metadata-vault");
  mkdirSync(join(tempRoot, "preserve-second-brain-review-metadata"), { recursive: true });
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "00-vision.md"), "# Vision\n\nPreserve Second Brain metadata.");
  process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE = statusFile;
  process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT = "1";
  writeFileSync(
    statusFile,
    JSON.stringify(
      {
        ok: true,
        secondBrainReviewMetadata: {
          auto_process: "obsidian_internal_only",
          processing_status: "review_ready",
          suggested_destination: "05_Projects",
          progressive_summary: "Ready for weekly review.",
          source_of_truth: "existing status JSON",
          external_action_required: false,
          approval_required: false
        }
      },
      null,
      2
    )
  );

  const autoExport = await import(`../obsidian/autoExport.js?status-preserve-second-brain-review=${Date.now()}`);
  const written = autoExport.runObsidianExportNow("preserve_second_brain_metadata", { vaultPath, docsDir });
  const persisted = JSON.parse(readFileSync(statusFile, "utf8")) as RowLike;

  assert.equal(written.ok, true);
  assert.equal(written.secondBrainReviewMetadata.processing_status, "review_ready");
  assert.equal(persisted.secondBrainReviewMetadata.processing_status, "review_ready");
  assert.equal(persisted.secondBrainReviewMetadata.source_of_truth, "existing status JSON");
});

test("Custom vault export keeps resume contract JSON inside the vault unless an explicit path is configured", async () => {
  db.initDb();
  db.resetDemoData();
  const previousResumeContractPath = process.env.AUTOMATION_OS_RESUME_CONTRACT_PATH;
  delete process.env.AUTOMATION_OS_RESUME_CONTRACT_PATH;
  const statusFile = join(tempRoot, "custom-resume-contract", "obsidian-export-status.json");
  process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE = statusFile;
  process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT = "1";
  const docsDir = join(tempRoot, "custom-resume-contract-docs");
  const vaultPath = join(tempRoot, "custom-resume-contract-vault");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "00-vision.md"), "# Vision\n\nCustom vault resume contract.");

  try {
    const autoExport = await import(`../obsidian/autoExport.js?custom-resume-contract=${Date.now()}`);
    const written = autoExport.runObsidianExportNow("custom_resume_contract", { vaultPath, docsDir });
    const expectedContractPath = join(vaultPath, "00_Start Here", "resume-contract.json");
    const resumeContractJson = JSON.parse(readFileSync(expectedContractPath, "utf8")) as {
      readFirst: Array<{ label: string; path: string }>;
    };

    assert.equal(written.ok, true);
    assert.equal(written.resumeContractJsonFile, expectedContractPath);
    assert.equal(resumeContractJson.readFirst[0]?.label, "Resume contract JSON");
    assert.equal(resumeContractJson.readFirst[0]?.path, expectedContractPath);
  } finally {
    if (previousResumeContractPath === undefined) {
      delete process.env.AUTOMATION_OS_RESUME_CONTRACT_PATH;
    } else {
      process.env.AUTOMATION_OS_RESUME_CONTRACT_PATH = previousResumeContractPath;
    }
  }
});

test("Obsidian auto export status ignores corrupt persisted JSON", async () => {
  const statusFile = join(tempRoot, "corrupt", "obsidian-export-status.json");
  mkdirSync(join(tempRoot, "corrupt"), { recursive: true });
  writeFileSync(statusFile, "{not-json");
  process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE = statusFile;

  const autoExport = await import(`../obsidian/autoExport.js?status-corrupt=${Date.now()}`);
  const status = autoExport.getObsidianExportStatus();

  assert.equal(status.ok, null);
  assert.equal(status.lastSuccessAt, null);
  assert.deepEqual(status.files, []);
  assert.ok(status.secondBrainPolicy.autoApprovedScopes.includes("obsidian_internal_classify"));
  assert.deepEqual(status.secondBrainPolicy.approvalRequiredScopes, ["billing_purchase_payment_checkout"]);
});

test("Obsidian disabled auto export status is persisted", async () => {
  const statusFile = join(tempRoot, "disabled", "obsidian-export-status.json");
  process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE = statusFile;
  process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT = "0";

  const autoExport = await import(`../obsidian/autoExport.js?status-disabled=${Date.now()}`);
  const status = autoExport.runObsidianAutoExportBestEffort("test_disabled");
  const persisted = JSON.parse(readFileSync(statusFile, "utf8")) as { reason?: string; enabled?: boolean };

  assert.equal(status.enabled, false);
  assert.equal(status.reason, "auto_export_disabled");
  assert.ok(status.secondBrainPolicy.autoApprovedScopes.includes("obsidian_internal_review_digest"));
  assert.equal(persisted.reason, "auto_export_disabled");
  assert.equal(persisted.enabled, false);
  process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT = "1";
});

test("Obsidian auto export can run detached without blocking the API process", async () => {
  db.initDb();
  db.resetDemoData();
  const previousDetached = process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT_DETACHED;
  const previousVault = process.env.AUTOMATION_OS_OBSIDIAN_VAULT;
  const previousAllowCustom = process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT;
  const previousSessionsDir = process.env.AUTOMATION_OS_CODEX_SESSIONS_DIR;
  const previousStatusFile = process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE;
  const statusFile = join(tempRoot, "detached", "obsidian-export-status.json");
  process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT = "1";
  process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT_DETACHED = "1";
  process.env.AUTOMATION_OS_OBSIDIAN_VAULT = join(tempRoot, "detached-vault");
  process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT = "1";
  process.env.AUTOMATION_OS_CODEX_SESSIONS_DIR = join(tempRoot, "detached-sessions");
  process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE = statusFile;
  mkdirSync(process.env.AUTOMATION_OS_CODEX_SESSIONS_DIR, { recursive: true });

  try {
    const autoExport = await import(`../obsidian/autoExport.js?detached=${Date.now()}`);
    const startedAt = Date.now();
    const status = autoExport.runObsidianAutoExportBestEffort("detached_api_state_change");

    assert.equal(status.ok, null);
    assert.equal(status.reason, "detached_api_state_change_queued");
    assert.ok(Date.now() - startedAt < 2000);

    await waitFor(() => {
      if (!existsSync(statusFile)) return false;
      const persisted = JSON.parse(readFileSync(statusFile, "utf8")) as { ok?: boolean; reason?: string };
      return persisted.ok === true && persisted.reason === "detached_api_state_change";
    }, 30000);
  } finally {
    if (previousDetached === undefined) delete process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT_DETACHED;
    else process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT_DETACHED = previousDetached;
    if (previousVault === undefined) delete process.env.AUTOMATION_OS_OBSIDIAN_VAULT;
    else process.env.AUTOMATION_OS_OBSIDIAN_VAULT = previousVault;
    if (previousAllowCustom === undefined) delete process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT;
    else process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT = previousAllowCustom;
    if (previousSessionsDir === undefined) delete process.env.AUTOMATION_OS_CODEX_SESSIONS_DIR;
    else process.env.AUTOMATION_OS_CODEX_SESSIONS_DIR = previousSessionsDir;
    if (previousStatusFile === undefined) delete process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE;
    else process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE = previousStatusFile;
  }
});

test("Periodic Obsidian export is disabled when interval is zero", async () => {
  process.env.AUTOMATION_OS_OBSIDIAN_PERIODIC_EXPORT_MS = "0";
  const autoExport = await import(`../obsidian/autoExport.js?periodic-disabled=${Date.now()}`);
  const controller = autoExport.startPeriodicObsidianExport();

  assert.equal(controller.enabled, false);
  assert.equal(controller.intervalMs, 0);
  controller.stop();
  delete process.env.AUTOMATION_OS_OBSIDIAN_PERIODIC_EXPORT_MS;
});

test("Periodic Obsidian export starts and writes status on interval", async () => {
  const statusFile = join(tempRoot, "periodic", "obsidian-export-status.json");
  const vaultPath = join(tempRoot, "periodic-vault");
  process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE = statusFile;
  process.env.AUTOMATION_OS_OBSIDIAN_VAULT = vaultPath;
  process.env.AUTOMATION_OS_OBSIDIAN_PERIODIC_EXPORT_MS = "20";

  const autoExport = await import(`../obsidian/autoExport.js?periodic-enabled=${Date.now()}`);
  const controller = autoExport.startPeriodicObsidianExport();
  try {
    assert.equal(controller.enabled, true);
    assert.equal(controller.intervalMs, 20);
    autoExport.runPeriodicExportTick("periodic");
    await waitFor(() => existsSync(statusFile), 500);
    const persisted = JSON.parse(readFileSync(statusFile, "utf8")) as { ok?: boolean; reason?: string; vaultPath?: string };
    assert.equal(persisted.ok, true);
    assert.equal(persisted.reason, "periodic");
    assert.equal(persisted.vaultPath, vaultPath);
  } finally {
    controller.stop();
    delete process.env.AUTOMATION_OS_OBSIDIAN_PERIODIC_EXPORT_MS;
    delete process.env.AUTOMATION_OS_OBSIDIAN_VAULT;
  }
});

test("Obsidian exports share one single-flight boundary across manual, state-change, and periodic triggers", async () => {
  const statusFile = join(tempRoot, "single-flight", "obsidian-export-status.json");
  process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE = statusFile;
  process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT = "1";
  const autoExport = await import(`../obsidian/autoExport.js?single-flight=${Date.now()}`);
  const fakeResult = {
    vaultPath: join(tempRoot, "single-flight-vault"),
    outputDir: join(tempRoot, "single-flight-vault", "02_Systems", "automation-os"),
    files: [],
    runs: 0,
    proofs: 0,
    docs: 0,
    missionFiles: [],
    secondBrainFiles: [],
    dashboardFiles: [],
    orientationFiles: [],
    templateFiles: []
  };

  const nestedStatuses: Array<{ reason: string | null }> = [];
  const outer = autoExport.runObsidianExportAttemptForTest("outer_export", () => {
    nestedStatuses.push(autoExport.runObsidianExportNow("manual_nested"));
    nestedStatuses.push(autoExport.runObsidianAutoExportBestEffort("state_change_nested"));
    const periodic = autoExport.runPeriodicExportTick("periodic_nested");
    assert.ok(periodic);
    nestedStatuses.push(periodic);
    return fakeResult;
  });

  assert.equal(outer.ok, true);
  assert.equal(outer.reason, "outer_export");
  assert.deepEqual(
    nestedStatuses.map((status) => status.reason),
    [
      "manual_nested_skipped_export_in_flight",
      "state_change_nested_skipped_export_in_flight",
      "periodic_nested_skipped_export_in_flight"
    ]
  );
  assert.ok(outer.secondBrainPolicy.autoApprovedScopes.includes("obsidian_internal_draft"));
  assert.ok(nestedStatuses.every((status) => Array.isArray((status as RowLike).secondBrainPolicy?.approvalRequiredScopes)));
  const persisted = JSON.parse(readFileSync(statusFile, "utf8")) as { reason?: string; ok?: boolean };
  assert.equal(persisted.ok, true);
  assert.equal(persisted.reason, "outer_export");
});

test("NODE_TEST_CONTEXT disables auto export unless explicitly enabled", async () => {
  const previousAutoExport = process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT;
  const previousNodeTestContext = process.env.NODE_TEST_CONTEXT;
  const statusFile = join(tempRoot, "node-test-context", "obsidian-export-status.json");
  process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE = statusFile;
  delete process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT;
  process.env.NODE_TEST_CONTEXT = "1";
  try {
    const disabledModule = await import(`../obsidian/autoExport.js?node-test-disabled=${Date.now()}`);
    const disabledStatus = disabledModule.runObsidianAutoExportBestEffort("node_test_context");

    assert.equal(disabledStatus.enabled, false);
    assert.equal(disabledStatus.reason, "auto_export_disabled");

    process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT = "1";
    const enabledModule = await import(`../obsidian/autoExport.js?node-test-enabled=${Date.now()}`);
    const enabledStatus = enabledModule.getObsidianExportStatus();

    assert.equal(enabledStatus.enabled, true);
  } finally {
    if (previousAutoExport === undefined) {
      process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT = "1";
    } else {
      process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT = previousAutoExport;
    }
    if (previousNodeTestContext === undefined) {
      delete process.env.NODE_TEST_CONTEXT;
    } else {
      process.env.NODE_TEST_CONTEXT = previousNodeTestContext;
    }
  }
});

test("Obsidian CLI export exits non-zero when export fails", () => {
  db.initDb();
  db.resetDemoData();
  const vaultPath = join(tempRoot, "cli-failure-vault");
  const outputDir = join(vaultPath, "02_Systems", "automation-os");
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, "Runs.md"), "---\nsystem: personal\n---\n\n# Hand written note\n");

  const result = spawnSync(process.execPath, [join(process.cwd(), "apps/server/dist/cli/exportObsidian.js"), `--vault=${vaultPath}`], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AUTOMATION_OS_DB: process.env.AUTOMATION_OS_DB ?? join(tempRoot, "automation-os.sqlite"),
      AUTOMATION_OS_OBSIDIAN_STATUS_FILE: join(tempRoot, "cli-failure-status.json"),
      AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT: "1"
    },
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /"ok": false/);
  assert.match(result.stdout, /Refusing to overwrite non-generated/);
});

test("Obsidian CLI export refuses custom vault without explicit export override", () => {
  db.initDb();
  db.resetDemoData();
  const vaultPath = join(tempRoot, "cli-custom-vault-refused");

  const result = spawnSync(process.execPath, [join(process.cwd(), "apps/server/dist/cli/exportObsidian.js"), `--vault=${vaultPath}`], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AUTOMATION_OS_DB: process.env.AUTOMATION_OS_DB ?? join(tempRoot, "automation-os.sqlite"),
      AUTOMATION_OS_OBSIDIAN_STATUS_FILE: join(tempRoot, "cli-custom-vault-refused-status.json"),
      AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT: "0"
    },
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /obsidian_custom_export_requires_approval/);
});

test("Obsidian CLI export records custom reason while keeping vault override", () => {
  db.initDb();
  db.resetDemoData();
  const vaultPath = join(tempRoot, "cli-reason-vault");
  const statusFile = join(tempRoot, "cli-reason-status.json");

  const result = spawnSync(process.execPath, [join(process.cwd(), "apps/server/dist/cli/exportObsidian.js"), `--vault=${vaultPath}`, "--reason=codex_stop_hook"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AUTOMATION_OS_DB: process.env.AUTOMATION_OS_DB ?? join(tempRoot, "automation-os.sqlite"),
      AUTOMATION_OS_OBSIDIAN_STATUS_FILE: statusFile,
      AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT: "1"
    },
    encoding: "utf8"
  });
  const persisted = JSON.parse(readFileSync(statusFile, "utf8")) as { reason?: string; vaultPath?: string };

  assert.equal(result.status, 0);
  assert.match(result.stdout, /"reason": "codex_stop_hook"/);
  assert.equal(persisted.reason, "codex_stop_hook");
  assert.equal(persisted.vaultPath, vaultPath);
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out after ${timeoutMs}ms`);
}

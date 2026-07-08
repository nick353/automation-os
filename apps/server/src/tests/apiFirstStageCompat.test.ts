import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { pathToFileURL } from "node:url";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-first-stage-"));
const skillRoot = join(tempRoot, "skills");
const pluginRoot = join(tempRoot, "plugins");
const automationRoot = join(tempRoot, "automations");
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");
process.env.AUTOMATION_OS_SECRET_DIR = join(tempRoot, "secrets");
process.env.AUTOMATION_OS_CODEX_SKILL_ROOTS = skillRoot;
process.env.AUTOMATION_OS_CODEX_PLUGIN_ROOTS = pluginRoot;
process.env.AUTOMATION_OS_CODEX_AUTOMATIONS_ROOT = automationRoot;
process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE = join(tempRoot, "api-obsidian-status.json");
process.env.AUTOMATION_OS_RESUME_CONTRACT_PATH = join(tempRoot, "api-resume-contract.json");
process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT = "1";
process.env.AUTOMATION_OS_DAILY_AI_PLAYWRIGHT_RUNNER = join(tempRoot, "missing-daily-ai-playwright-runner.mjs");
process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER = join(tempRoot, "missing-nisenprints-playwright-runner.mjs");
process.env.AUTOMATION_OS_SNS_MULTI_POSTER_RUNNER = join(tempRoot, "missing-sns-multi-poster-runner.mjs");
process.env.AUTOMATION_OS_PROMPT_TRANSFER_UKIYOE_RUNNER = join(tempRoot, "missing-prompt-transfer-runner.py");
process.env.AUTOMATION_OS_CODEX_BIN = join(tempRoot, "missing-codex-bin");

const { app, classifyWorkerOnceExit, markRunsResumeSuppressed, runResearchPlanSchedulerOnce } = await import("../index.js");
const db = await import("../db/client.js");
const secrets = await import("../secrets/secretStore.js");
const knowledge = await import("../knowledge/refresh.js");
const urlCapture = await import("../obsidian/urlCapture.js");

const publicRegisteredWorkflowKeys = [
  "boundary_label",
  "check_kind",
  "check_label",
  "freshness_kind",
  "freshness_label",
  "id",
  "last_action_label",
  "last_result_label",
  "last_run_id",
  "name",
  "needs_check",
  "next_action_label",
  "next_action_view",
  "safety_kind",
  "safety_label",
  "schedule_label",
  "status",
  "trust_kind",
  "trust_label"
];
const internalRegisteredWorkflowKeys = [
  "runner_status",
  "runner_kind",
  "project_root",
  "start_command_json",
  "source_refs_json",
  "provenance_json",
  "schedule_json",
  "scheduleControl",
  "source_refs",
  "provenance"
];

test("POST /api/approvals/:id/cancel cancels a pending approval and marks the run cancelled", async () => {
  db.initDb();
  db.resetDemoData();
  const previousAutoExport = process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT;
  const previousVault = process.env.AUTOMATION_OS_OBSIDIAN_VAULT;
  const previousStatusFile = process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE;
  const statusFile = join(tempRoot, "approval-cancel-status.json");
  process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT = "1";
  process.env.AUTOMATION_OS_OBSIDIAN_VAULT = join(tempRoot, "approval-cancel-vault");
  process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE = statusFile;
  const now = db.nowIso();
  db.insert("runs", {
    id: "run_cancel",
    name: "Publish needs approval",
    status: "waiting_approval",
    objective: "Publish after approval",
    created_at: now,
    updated_at: now,
    metadata_json: {}
  });
  db.insert("run_steps", {
    id: "step_cancel",
    run_id: "run_cancel",
    name: "Protected publish",
    status: "waiting_approval",
    lane_id: null,
    started_at: null,
    completed_at: null,
    metadata_json: { requires_approval: true }
  });
  db.insert("approvals", {
    id: "approval_cancel",
    run_id: "run_cancel",
    title: "Approve publish",
    requested_by: "test",
    status: "pending",
    priority: "medium",
    approval_group_id: "group_cancel",
    resource_locks_json: ["social_publish"],
    created_at: now,
    decided_at: null,
    decision_note: null
  });

  try {
    const response = await postJson("/api/approvals/approval_cancel/cancel", {});
    const body = JSON.parse(response.body) as { status: string; decision_note: string };
    const run = db.querySql<{ status: string; metadata_json: string }>("SELECT status, metadata_json FROM runs WHERE id='run_cancel'")[0];
    const metadata = JSON.parse(run.metadata_json) as { stop_reason?: string };
    const obsidianStatus = JSON.parse(readFileSync(statusFile, "utf8")) as { ok: boolean; reason: string };

    assert.equal(response.status, 200);
    assert.equal(body.status, "cancelled");
    assert.equal(body.decision_note, "Cancelled from Control Panel");
    assert.equal(run.status, "cancelled");
    assert.equal(metadata.stop_reason, "approval_cancelled");
    assert.equal(obsidianStatus.ok, true);
    assert.equal(obsidianStatus.reason, "approval-cancelled");
  } finally {
    if (previousAutoExport === undefined) delete process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT;
    else process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT = previousAutoExport;
    if (previousVault === undefined) delete process.env.AUTOMATION_OS_OBSIDIAN_VAULT;
    else process.env.AUTOMATION_OS_OBSIDIAN_VAULT = previousVault;
    if (previousStatusFile === undefined) delete process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE;
    else process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE = previousStatusFile;
  }
});

test("POST /api/approvals/:id/approve returns before protected worker execution completes", async () => {
  db.initDb();
  db.resetDemoData();
  const now = db.nowIso();
  db.insert("runs", {
    id: "run_async_approval",
    name: "Async approval worker",
    status: "waiting_approval",
    objective: "SNS Multi Poster Ukiyoe registered workflow billing-only post publish",
    created_at: now,
    updated_at: now,
    metadata_json: {}
  });
  db.insert("run_steps", {
    id: "step_async_approval",
    run_id: "run_async_approval",
    name: "SNS Multi Poster Ukiyoe registered workflow billing-only post publish",
    status: "waiting_approval",
    lane_id: null,
    started_at: null,
    completed_at: null,
    metadata_json: {
      resources: ["social_publish"],
      dangerous_action: true,
      requires_approval: true,
      adapter: "sns_multi_poster_registered",
      parallel_safe: true
    }
  });
  db.insert("approvals", {
    id: "approval_async",
    run_id: "run_async_approval",
    title: "Approve async worker",
    requested_by: "test",
    status: "pending",
    priority: "high",
    approval_group_id: "group_async",
    resource_locks_json: ["social_publish"],
    created_at: now,
    decided_at: null,
    decision_note: null
  });

  const response = await postJson("/api/approvals/approval_async/approve", {});
  const body = JSON.parse(response.body) as { status: string; run_id: string };
  const runImmediately = db.querySql<{ status: string }>("SELECT status FROM runs WHERE id='run_async_approval'")[0];
  const dashboardResponse = await getJson("/api/dashboard");

  assert.equal(response.status, 200);
  assert.equal(body.status, "approved");
  assert.equal(body.run_id, "run_async_approval");
  assert.equal(["waiting_approval", "running", "blocked"].includes(runImmediately.status), true);
  assert.equal(dashboardResponse.status, 200);
});

test("worker once exit classification does not mark waiting approval run as before progress after worker started", () => {
  db.initDb();
  db.resetDemoData();
  const now = db.nowIso();
  db.insert("runs", {
    id: "run_worker_once_progressed",
    name: "Worker once progressed regression",
    status: "waiting_approval",
    objective: "Job Application Daily Submit Queue registered workflow billing-only submit",
    created_at: now,
    updated_at: now,
    metadata_json: {}
  });
  db.insert("run_steps", {
    id: "step_worker_once_progressed",
    run_id: "run_worker_once_progressed",
    name: "Job submit registered worker",
    status: "running",
    lane_id: null,
    started_at: now,
    completed_at: null,
    metadata_json: {
      requires_approval: true,
      adapter: "job_submit_registered"
    }
  });
  db.insert("worker_events", {
    id: "evt_worker_once_progressed_started",
    run_id: "run_worker_once_progressed",
    step_id: "step_worker_once_progressed",
    lane_id: null,
    event_type: "worker_started",
    message: "codex exec started",
    created_at: now,
    metadata_json: {}
  });

  const classification = classifyWorkerOnceExit("run_worker_once_progressed");

  assert.equal(classification.progress.progressed, true);
  assert.equal(classification.progress.counts.stepsStarted, 1);
  assert.equal(classification.progress.counts.workerStartedEvents, 1);
  assert.equal(classification.exactBlocker, "worker_once_exited_after_run_progress_without_final_status");
  assert.notEqual(classification.exactBlocker, "worker_once_exited_before_run_progress");
});

test("GET /api/codex/capabilities scans skills, plugins, and bridge-backed capabilities", async () => {
  db.initDb();
  db.resetDemoData();
  mkdirSync(join(skillRoot, "demo-skill"), { recursive: true });
  mkdirSync(join(pluginRoot, "demo-plugin", ".codex-plugin"), { recursive: true });
  mkdirSync(join(automationRoot, "demo-automation"), { recursive: true });
  writeFileSync(
    join(skillRoot, "demo-skill", "SKILL.md"),
    "---\nname: demo-skill\ndescription: Demo skill for inventory.\n---\n\n# Demo\n"
  );
  writeFileSync(
    join(pluginRoot, "demo-plugin", ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "demo-plugin", description: "Demo plugin" })
  );
  writeFileSync(join(automationRoot, "demo-automation", "automation.toml"), "name = \"Demo automation\"\n");
  const response = await getJson("/api/codex/capabilities");
  const body = JSON.parse(response.body) as { summary: { skills: number; plugins: number; automations: number }; capabilities: { browser: { status: string }; mcp: { status: string } } };

  assert.equal(response.status, 200);
  assert.equal(body.summary.skills, 1);
  assert.equal(body.summary.plugins, 1);
  assert.equal(body.summary.automations, 1);
  assert.equal(body.capabilities.browser.status, "requires_bridge");
  assert.equal(body.capabilities.mcp.status, "available_with_codex_runtime");
});

test("GET /api/codex/automation-migration-ledger returns read-only migration summary", async () => {
  db.initDb();
  db.resetDemoData();
  mkdirSync(join(automationRoot, "api-ledger-registered"), { recursive: true });
  writeFileSync(
    join(automationRoot, "api-ledger-registered", "automation.toml"),
    [
      'id = "daily-ai-research-publish-run"',
      'name = "Daily AI Research + Publish Run"',
      'status = "ACTIVE"',
      'rrule = "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0"',
      'prompt = "Run registered workflow."'
    ].join("\n")
  );
  const now = db.nowIso();
  db.insert("registered_workflows", {
    id: "api-ledger-registered-only",
    name: "API ledger registered only",
    status: "active",
    runner_status: "connected",
    runner_kind: "daily_ai_registered",
    project_root: tempRoot,
    start_command_json: { command: "API ledger registered only", source: "test" },
    schedule_json: { kind: "cron", rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0" },
    source_refs_json: [],
    provenance_json: { scheduler: { lastRunId: "run_api_ledger_registered_only" } },
    created_at: now,
    updated_at: now
  });
  db.insert("runs", {
    id: "run_api_ledger_registered_only",
    name: "API ledger registered only run",
    status: "complete",
    objective: "API ledger registered only",
    created_at: now,
    updated_at: now,
    metadata_json: {
      plan: { tasks: [{ adapter: "daily_ai_registered" }] },
      proof_gate: { ok: true, missing: [], present: ["daily_ai_publish"] }
    }
  });
  db.insert("proofs", {
    id: "proof_api_ledger_registered_only",
    run_id: "run_api_ledger_registered_only",
    step_id: null,
    proof_type: "daily_ai_publish",
    label: "Daily AI publish",
    uri: "file:///tmp/daily-ai-publish.json",
    size_bytes: 2,
    created_at: now,
    metadata_json: {}
  });

  const response = await getJson("/api/codex/automation-migration-ledger");
  const body = JSON.parse(response.body) as {
    summary: {
      total: number;
      registered: number;
      registeredWorkflowTotal: number;
      migrated: number;
      scheduledConfirmed: number;
      actualConfirmed: number;
      proofConfirmed: number;
    };
    items: Array<{
      id: string;
      status: string;
      inventorySource: string;
      automationOsMigrated: boolean;
      scheduledOperationConfirmed: boolean;
      actualOperationConfirmed: boolean;
      proofConfirmed: boolean;
      latestRunId: string | null;
      latestProofTypes: string[];
      registeredWorkflowId: string | null;
    }>;
  };

  assert.equal(response.status, 200);
  assert.ok(body.summary.total >= 1);
  assert.ok(body.summary.registered >= 1);
  assert.ok(body.summary.registeredWorkflowTotal >= 1);
  assert.ok(body.summary.migrated >= 1);
  assert.ok(body.summary.scheduledConfirmed >= 1);
  assert.ok(body.summary.actualConfirmed >= 1);
  assert.ok(body.summary.proofConfirmed >= 1);
  assert.ok(body.items.some((item) => item.id === "daily-ai-research-publish-run" && item.status === "registered"));
  const registeredOnly = body.items.find((item) => item.id === "api-ledger-registered-only");
  assert.ok(registeredOnly);
  assert.equal(registeredOnly.inventorySource, "registered_workflow");
  assert.equal(registeredOnly.registeredWorkflowId, "api-ledger-registered-only");
  assert.equal(registeredOnly.automationOsMigrated, true);
  assert.equal(registeredOnly.scheduledOperationConfirmed, true);
  assert.equal(registeredOnly.actualOperationConfirmed, true);
  assert.equal(registeredOnly.proofConfirmed, true);
  assert.equal(registeredOnly.latestRunId, "run_api_ledger_registered_only");
  assert.ok(registeredOnly.latestProofTypes.includes("daily_ai_publish"));
});

test("registered workflows API seeds fixed native, skill, and lane workflows and refreshes stale DB rows", async () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM registered_workflows;");
  db.execSql(`
    INSERT INTO registered_workflows (
      id,
      name,
      status,
      runner_status,
      runner_kind,
      project_root,
      schedule_json,
      source_refs_json,
      provenance_json,
      created_at,
      updated_at
    ) VALUES (
      'daily-ai-research-publish-run',
      'stale name',
      'active',
      'stale_runner',
      'not_connected',
      '/tmp/stale',
      '{}',
      '[]',
      '{}',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z'
    );
  `);

  const getResponse = await getJson("/api/registered-workflows");
  const getBody = JSON.parse(getResponse.body) as {
    workflows: Array<Record<string, unknown>>;
  };
  const dailyAi = getBody.workflows.find((workflow) => workflow.id === "daily-ai-research-publish-run");
  const nisenPrints = getBody.workflows.find((workflow) => workflow.id === "nisenprints-daily-product-canva-printify-etsy-pinterest");
  const promptTransfer = getBody.workflows.find((workflow) => workflow.id === "prompt-transfer-ukiyoe");
  const sns = getBody.workflows.find((workflow) => workflow.id === "sns-multi-poster-ukiyoe");
  const xLane = getBody.workflows.find((workflow) => workflow.id === "x-authenticated-browser-lane");

  assert.equal(getResponse.status, 200);
  assert.equal(getBody.workflows.length, 6);
  assertPublicRegisteredWorkflowRows(getBody.workflows);
  assert.ok(dailyAi);
  assert.equal(dailyAi.name, "Daily AI");
  assert.ok(nisenPrints);
  assert.equal(nisenPrints.name, "NisenPrints");
  assert.ok(promptTransfer);
  assert.equal(promptTransfer.name, "転記");
  assert.ok(sns);
  assert.equal(sns.name, "SNS");
  assert.ok(xLane);
  assert.equal(xLane.name, "X");

  const rawRows = db.querySql<{
    id: string;
    runner_status: string;
    runner_kind: string;
    start_command_json: string;
    source_refs_json: string;
    provenance_json: string;
  }>("SELECT id, runner_status, runner_kind, start_command_json, source_refs_json, provenance_json FROM registered_workflows ORDER BY id;");
  const rawDailyAi = rawRows.find((workflow) => workflow.id === "daily-ai-research-publish-run");
  const rawPromptTransfer = rawRows.find((workflow) => workflow.id === "prompt-transfer-ukiyoe");
  const rawSns = rawRows.find((workflow) => workflow.id === "sns-multi-poster-ukiyoe");
  const rawXLane = rawRows.find((workflow) => workflow.id === "x-authenticated-browser-lane");
  assert.ok(rawDailyAi);
  assert.equal(rawDailyAi.runner_status, "connected");
  assert.equal(rawDailyAi.runner_kind, "daily_ai_registered");
  assert.deepEqual(JSON.parse(rawDailyAi.start_command_json), {
    command: "Daily AI registered workflow run full flow",
    source: "fixed_automation_os_entrypoint"
  });
  assert.ok(rawPromptTransfer);
  assert.equal(rawPromptTransfer.runner_status, "connected");
  assert.equal(rawPromptTransfer.runner_kind, "prompt_transfer_registered");
  assert.equal(JSON.parse(rawPromptTransfer.start_command_json).source, "skill");
  assert.equal(JSON.parse(rawPromptTransfer.source_refs_json)[0]?.type, "skill");
  assert.ok(rawSns);
  assert.equal(JSON.parse(rawSns.start_command_json).source, "skill");
  assert.ok(rawXLane);
  assert.equal(JSON.parse(rawXLane.start_command_json).source, "native");
  assert.deepEqual(JSON.parse(rawDailyAi.source_refs_json), [
    {
      type: "automation_toml",
      path: "/Users/nichikatanaka/.codex/automations/daily-ai-research-publish-run/automation.toml",
      legacyAutomationId: "daily-ai-research-publish-run"
    }
  ]);
  assert.equal(JSON.parse(rawDailyAi.provenance_json).codexAppContinuousSync, false);

  db.execSql("UPDATE registered_workflows SET runner_status='stale_runner' WHERE id='daily-ai-research-publish-run';");
  const refreshResponse = await postJson("/api/registered-workflows/refresh", {});
  const refreshBody = JSON.parse(refreshResponse.body) as { workflows: Array<Record<string, unknown>> };
  const refreshedDailyAi = refreshBody.workflows.find((workflow) => workflow.id === "daily-ai-research-publish-run");
  const dbRows = db.querySql<{ count: number }>("SELECT count(*) AS count FROM registered_workflows;")[0];
  const refreshedRawDailyAi = db.querySql<{ runner_status: string }>("SELECT runner_status FROM registered_workflows WHERE id='daily-ai-research-publish-run'")[0];

  assert.equal(refreshResponse.status, 200);
  assert.equal(refreshBody.workflows.length, 6);
  assertPublicRegisteredWorkflowRows(refreshBody.workflows);
  assert.ok(refreshedDailyAi);
  assert.equal(refreshedDailyAi.runner_status, undefined);
  assert.equal(refreshedRawDailyAi.runner_status, "connected");
  assert.equal(dbRows.count, 6);
});

test("registered workflow rehearsal run-once is static and public", async () => {
  db.initDb();
  db.resetDemoData();
  const refresh = await postJson("/api/registered-workflows/refresh", {});
  insertResearchPlannerReviewWorkflows(1, "active");
  insertResearchPlannerReviewWorkflows(2, "inactive");
  const beforeRuns = db.querySql<{ count: number }>("SELECT count(*) AS count FROM runs;")[0];

  const response = await postJson("/api/registered-workflows/rehearsal/run-once", {});
  const body = JSON.parse(response.body) as {
    ok: boolean;
    checked: number;
    failed: number;
    review_required: number;
    labels: string[];
    workflows: Array<Record<string, unknown>>;
  };
  const afterRuns = db.querySql<{ count: number }>("SELECT count(*) AS count FROM runs;")[0];
  const check = db.querySql<{ kind: string; status: string; summary: string; metadata_json: string }>(
    "SELECT kind, status, summary, metadata_json FROM system_checks WHERE kind='registered_workflow_rehearsal' ORDER BY created_at DESC LIMIT 1"
  )[0];
  const serialized = JSON.stringify(body);

  assert.equal(refresh.status, 200);
  assert.equal(response.status, 200);
  assert.equal(Number(afterRuns.count), Number(beforeRuns.count));
  assert.equal(body.ok, false);
  assert.equal(body.failed, 0);
  assert.equal(body.review_required, 1);
  assert.equal(body.checked, 7);
  assert.equal(body.workflows.length, 7);
  assert.ok(body.labels.some((label) => label.includes("Daily AI:課金停止")));
  assert.ok(body.labels.some((label) => label.includes("SNS:課金停止")));
  assert.ok(body.labels.some((label) => label.includes("X:課金停止")));
  assert.equal(body.workflows.filter((workflow) => workflow.status === "review_required").length, 1);
  assert.equal(body.workflows.some((workflow) => String(workflow.id).includes("inactive")), false);
  assert.ok(body.workflows.every((workflow) => Object.keys(workflow).sort().join(",") === "id,name,safety_kind,safety_label,status"));
  assert.ok(body.workflows.every((workflow) => workflow.status === "ok" || workflow.status === "review_required"));
  assert.ok(check);
  assert.equal(check.status, "review_required");
  assert.equal(check.summary, "定期リハーサルに確認が必要です");
  assert.match(check.metadata_json, /"ok":false/);
  assert.match(check.metadata_json, /"review_required":1/);
  assert.equal(JSON.parse(check.metadata_json).failed, 0);
  assert.equal(JSON.parse(check.metadata_json).review_required, 1);
  assert.equal(check.kind, "registered_workflow_rehearsal");
  assert.match(check.status, /^review_required$/);
  assert.doesNotMatch(serialized, /startCommand|provenance|project_root|runner_|exactBlocker|\/Users|data\/artifacts|metadata_json|resource_locks|external_action_executed":true/i);
});

test("registered workflow public rows prioritize Research Planner identity over X or publish command text", async () => {
  db.initDb();
  db.resetDemoData();
  await postJson("/api/registered-workflows/refresh", {});
  const now = db.nowIso();
  for (const row of [
    {
      id: "research-plan-runner-x-publish",
      name: "X publish plan runner should stay morning check",
      runner_kind: "research_plan_registered",
      start_command_json: {
        command: "Check X publish readiness",
        source: "native",
        visibleFlow: ["確認する"]
      }
    },
    {
      id: "research-plan-source-x-publish",
      name: "X publish plan source should stay morning check",
      runner_kind: "x_authenticated_browser_lane_registered",
      start_command_json: {
        command: "Check X publish readiness",
        source: "research_plan",
        researchPlanId: "source-x-publish",
        visibleFlow: ["確認する"]
      }
    }
  ]) {
    db.insert("registered_workflows", {
      id: row.id,
      name: row.name,
      status: "active",
      runner_status: "connected",
      runner_kind: row.runner_kind,
      project_root: "/Users/nichikatanaka/Documents/Codex/automation-os",
      start_command_json: row.start_command_json,
      schedule_json: {
        kind: "cron",
        rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
        timezone: "Asia/Taipei",
        label: "毎日 09:00"
      },
      source_refs_json: [{ type: "research_plan", path: `research_plans:${row.id}`, researchPlanId: row.id }],
      provenance_json: {
        source: "research_plan_regularized",
        researchPlanId: row.id,
        demoCheckId: null,
        codexAppContinuousSync: true,
        snapshotRole: "scheduled_entry_not_completion_proof"
      },
      created_at: now,
      updated_at: now
    });
  }

  const response = await getJson("/api/registered-workflows");
  const body = JSON.parse(response.body) as { workflows: Array<Record<string, unknown>> };
  const runnerPriority = body.workflows.find((workflow) => workflow.id === "research-plan-runner-x-publish");
  const sourcePriority = body.workflows.find((workflow) => workflow.id === "research-plan-source-x-publish");

  assert.equal(response.status, 200);
  assert.equal(runnerPriority?.name, "朝チェック");
  assert.equal(runnerPriority?.boundary_label, "確認");
  assert.equal(sourcePriority?.name, "朝チェック");
  assert.equal(sourcePriority?.boundary_label, "確認");
});

test("registered workflow rehearsal detects unsafe latest run metadata beyond proof metadata", async () => {
  db.initDb();
  db.resetDemoData();
  await postJson("/api/registered-workflows/refresh", {});
  const now = db.nowIso();
  const artifactPath = join(tempRoot, "rehearsal-unsafe-proof-artifact.json");
  writeFileSync(artifactPath, JSON.stringify({ runner_safety: { externalActionExecutedByRehearsal: true } }), "utf8");
  db.insert("runs", {
    id: "run_rehearsal_unsafe_x",
    name: "X authenticated browser lane registered workflow billing-only x.com save lane proof",
    status: "partial",
    objective: "X authenticated browser lane registered workflow billing-only x.com save lane proof",
    created_at: now,
    updated_at: now,
    metadata_json: {
      registered_workflow_id: "x-authenticated-browser-lane",
      proof_gate: {
        ok: false,
        missing: ["x_authenticated_browser_lane_human_input_required_with_evidence"],
        present: ["x_authenticated_browser_lane_registered:human_input_required_with_evidence"]
      }
    }
  });
  db.insert("run_steps", {
    id: "step_rehearsal_unsafe_x",
    run_id: "run_rehearsal_unsafe_x",
    name: "X boundary",
    status: "blocked",
    lane_id: null,
    started_at: now,
    completed_at: now,
    metadata_json: {
      execution_mode: "human_input_required_with_evidence",
      external_action_executed: false
    }
  });
  db.insert("proofs", {
    id: "proof_rehearsal_unsafe_x",
    run_id: "run_rehearsal_unsafe_x",
    step_id: "step_rehearsal_unsafe_x",
    proof_type: "x_authenticated_browser_lane_registered_blocked",
    label: "X blocked",
    uri: pathToFileURL(artifactPath).href,
    size_bytes: 2,
    created_at: now,
    metadata_json: {
      external_action_executed: false
    }
  });

  const response = await postJson("/api/registered-workflows/rehearsal/run-once", {});
  const body = JSON.parse(response.body) as { ok: boolean; failed: number; workflows: Array<{ id: string; status: string }> };
  const xWorkflow = body.workflows.find((workflow) => workflow.id === "x-authenticated-browser-lane");

  assert.equal(response.status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.failed, 1);
  assert.equal(xWorkflow?.status, "unsafe");
});

test("registered workflow rehearsal allows approved non-billing external action evidence", async () => {
  db.initDb();
  db.resetDemoData();
  await postJson("/api/registered-workflows/refresh", {});
  const now = db.nowIso();
  const artifactPath = join(tempRoot, "rehearsal-approved-post-proof-artifact.json");
  writeFileSync(artifactPath, JSON.stringify({ external_action_executed: true, externalActionExecutedByRehearsal: false }), "utf8");
  db.insert("runs", {
    id: "run_rehearsal_approved_post",
    name: "SNS Multi Poster approved post proof",
    status: "completed",
    objective: "SNS Multi Poster approved post proof",
    created_at: now,
    updated_at: now,
    metadata_json: {
      registered_workflow_id: "sns-multi-poster-ukiyoe",
      proof_gate: { ok: true, missing: [], present: ["sns_multi_poster_external_post_done"] },
      runner_safety: {
        approvalStatus: "approved",
        external_action_executed: true,
        approvedExternalActions: ["post", "publish"],
        defaultHardStops: ["billing", "purchase", "payment", "checkout"]
      }
    }
  });
  db.insert("run_steps", {
    id: "step_rehearsal_approved_post",
    run_id: "run_rehearsal_approved_post",
    name: "SNS approved post",
    status: "completed",
    lane_id: null,
    started_at: now,
    completed_at: now,
    metadata_json: {
      external_action_executed: true,
      defaultHardStops: ["billing", "purchase", "payment", "checkout"]
    }
  });
  db.insert("proofs", {
    id: "proof_rehearsal_approved_post",
    run_id: "run_rehearsal_approved_post",
    step_id: "step_rehearsal_approved_post",
    proof_type: "sns_multi_poster_external_post_done",
    label: "SNS posted",
    uri: pathToFileURL(artifactPath).href,
    size_bytes: 2,
    created_at: now,
    metadata_json: {
      external_action_executed: true,
      externalActionExecutedByRehearsal: false,
      defaultHardStops: ["billing", "purchase", "payment", "checkout"]
    }
  });

  const response = await postJson("/api/registered-workflows/rehearsal/run-once", {});
  const body = JSON.parse(response.body) as { ok: boolean; failed: number; workflows: Array<{ id: string; status: string }> };
  const snsWorkflow = body.workflows.find((workflow) => workflow.id === "sns-multi-poster-ukiyoe");

  assert.equal(response.status, 200);
  assert.equal(body.failed, 0);
  assert.equal(snsWorkflow?.status, "ok");
});

test("registered workflow start API creates Automation OS runs from fixed entrypoints", async () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM registered_workflows;");

  const missing = await postJson("/api/registered-workflows/not-registered/start", {});
  assert.equal(missing.status, 404);

  const now = db.nowIso();
  db.insert("registered_workflows", {
    id: "research-plan-inactive-api-test",
    name: "Inactive research plan",
    status: "inactive",
    runner_status: "connected",
    runner_kind: "research_plan_registered",
    project_root: "/Users/nichikatanaka/Documents/Codex/automation-os",
    start_command_json: { command: "Inactive research plan", source: "research_plan", researchPlanId: "missing-inactive-plan", visibleFlow: [] },
    schedule_json: { kind: "cron", rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0", label: "毎日 09:00" },
    source_refs_json: [],
    provenance_json: { source: "research_plan_regularized" },
    created_at: now,
    updated_at: now
  });
  const inactive = await postJson("/api/registered-workflows/research-plan-inactive-api-test/start", {});
  const inactiveBody = JSON.parse(inactive.body) as { error: string };
  assert.equal(inactive.status, 409);
  assert.equal(inactiveBody.error, "registered_workflow_inactive");
  db.execSql("DELETE FROM registered_workflows WHERE id='research-plan-inactive-api-test';");

  db.insert("registered_workflows", {
    id: "inactive-broken-command-api-test",
    name: "Inactive broken command",
    status: "INACTIVE",
    runner_status: "connected",
    runner_kind: "unsupported_runner",
    project_root: "/Users/nichikatanaka/Documents/Codex/automation-os",
    start_command_json: {},
    schedule_json: {},
    source_refs_json: [],
    provenance_json: {},
    created_at: now,
    updated_at: now
  });
  const inactiveBroken = await postJson("/api/registered-workflows/inactive-broken-command-api-test/start", {});
  const inactiveBrokenBody = JSON.parse(inactiveBroken.body) as { error: string };
  assert.equal(inactiveBroken.status, 409);
  assert.equal(inactiveBrokenBody.error, "registered_workflow_inactive");
  db.execSql("DELETE FROM registered_workflows WHERE id='inactive-broken-command-api-test';");

  const dailyResponse = await postJson("/api/registered-workflows/daily-ai-research-publish-run/start", {});
  const dailyBody = JSON.parse(dailyResponse.body) as {
    accepted?: boolean;
    runId?: string;
    status?: string;
    workflow: Record<string, unknown>;
    startCommand?: string;
    workerProtocol?: string;
    nextAction?: string;
    run: { runId: string; status: string };
  };
  const dailyRun = db.querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${db.sqlValue(dailyBody.run.runId)} LIMIT 1`)[0];
  const dailyMetadata = JSON.parse(dailyRun.metadata_json);

  assert.equal(dailyResponse.status, 202);
  assert.equal(dailyBody.accepted, true);
  assert.equal(dailyBody.runId, dailyBody.run.runId);
  assert.equal(dailyBody.status, dailyBody.run.status);
  assertPublicRegisteredWorkflowRow(dailyBody.workflow);
  assert.equal(dailyBody.workflow.id, "daily-ai-research-publish-run");
  assert.equal(dailyBody.workflow.name, "Daily AI");
  assert.equal(dailyBody.workflow.check_kind, "none");
  assert.equal(dailyBody.workflow.trust_kind, "unknown");
  assert.equal(dailyBody.workflow.freshness_kind, "fresh");
  assert.equal(dailyBody.startCommand, undefined);
  assert.deepEqual(Object.keys(dailyBody.run).sort(), ["runId", "status"]);
  assert.equal(dailyMetadata.plan.tasks[0].adapter, "daily_ai_registered");
  assert.equal(dailyMetadata.plan.approvalRequired, false);
  assert.equal(dailyMetadata.registeredWorkflowId, "daily-ai-research-publish-run");
  assert.equal(dailyMetadata.registered_workflow_id, "daily-ai-research-publish-run");
  assert.equal(dailyMetadata.workflowId, "daily-ai-research-publish-run");
  assert.equal(dailyMetadata.workflow_id, "daily-ai-research-publish-run");
  assert.equal(dailyBody.workerProtocol, "local_worker_loop_required");
  assert.match(String(dailyBody.nextAction), /npm run worker:loop/);
  assert.deepEqual(dailyMetadata.registered_workflow_start, {
    source: "manual",
    runnerKind: "daily_ai_registered"
  });
  assert.equal(dailyMetadata.worker_protocol, "local_worker_loop_required");
  assert.equal(dailyMetadata.worker_mode, "queued_for_local_worker_loop");
  assert.equal(dailyMetadata.worker_loop.requiredCommand, "npm run worker:loop");
  assert.equal(dailyBody.run.status, "queued");
  assert.equal(dailyRun.status, "queued");
  assert.equal(dailyMetadata.blocker, undefined);
  assert.equal(db.querySql<{ count: number }>("SELECT count(*) AS count FROM worker_events WHERE run_id=" + db.sqlValue(dailyBody.run.runId) + " AND event_type='queued_for_worker_loop'")[0].count, 1);
  const dailyWorkflow = db.querySql<{ provenance_json: string }>("SELECT provenance_json FROM registered_workflows WHERE id='daily-ai-research-publish-run'")[0];
  const dailyProvenance = JSON.parse(dailyWorkflow.provenance_json) as { manual?: { lastManualRunId?: string; lastManualStartedAt?: string }; scheduler?: { lastManualRunId?: string; lastManualStartedAt?: string } };
  assert.equal(dailyProvenance.manual?.lastManualRunId, dailyBody.run.runId);
  assert.equal(typeof dailyProvenance.manual?.lastManualStartedAt, "string");
  assert.equal(dailyProvenance.scheduler?.lastManualRunId, dailyBody.run.runId);
  assert.equal(typeof dailyProvenance.scheduler?.lastManualStartedAt, "string");

  const nisenResponse = await postJson("/api/registered-workflows/nisenprints-daily-product-canva-printify-etsy-pinterest/start", {});
  const nisenBody = JSON.parse(nisenResponse.body) as {
    accepted?: boolean;
    runId?: string;
    status?: string;
    workflow: Record<string, unknown>;
    startCommand?: string;
    workerProtocol?: string;
    nextAction?: string;
    run: { runId: string; status: string };
  };
  const nisenRun = db.querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${db.sqlValue(nisenBody.run.runId)} LIMIT 1`)[0];
  const nisenMetadata = JSON.parse(nisenRun.metadata_json);

  assert.equal(nisenResponse.status, 202);
  assert.equal(nisenBody.accepted, true);
  assert.equal(nisenBody.runId, nisenBody.run.runId);
  assert.equal(nisenBody.status, nisenBody.run.status);
  assertPublicRegisteredWorkflowRow(nisenBody.workflow);
  assert.equal(nisenBody.workflow.id, "nisenprints-daily-product-canva-printify-etsy-pinterest");
  assert.equal(nisenBody.workflow.name, "NisenPrints");
  assert.equal(nisenBody.workflow.check_kind, "none");
  assert.equal(nisenBody.workflow.trust_kind, "unknown");
  assert.equal(nisenBody.workflow.freshness_kind, "fresh");
  assert.equal(nisenBody.startCommand, undefined);
  assert.deepEqual(Object.keys(nisenBody.run).sort(), ["runId", "status"]);
  assert.equal(nisenMetadata.plan.tasks[0].adapter, "nisenprints_registered");
  assert.equal(nisenMetadata.plan.approvalRequired, false);
  assert.equal(nisenMetadata.run_contract.mode, "nisenprints_full_publish_run");
  assert.equal(nisenBody.workerProtocol, "local_worker_loop_required");
  assert.match(String(nisenBody.nextAction), /npm run worker:loop/);
  assert.equal(nisenMetadata.worker_protocol, "local_worker_loop_required");
  assert.equal(nisenMetadata.worker_mode, "queued_for_local_worker_loop");
  assert.equal(nisenMetadata.worker_loop.requiredCommand, "npm run worker:loop");
  assert.equal(nisenBody.run.status, "queued");
  assert.equal(nisenRun.status, "queued");
  assert.equal(nisenMetadata.blocker, undefined);
});

test("registered workflow scheduler starts due fixed registered workflows with provenance metadata", async () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM registered_workflows;");
  await postJson("/api/registered-workflows/refresh", {});
  db.execSql(`
    UPDATE registered_workflows
    SET created_at='2026-06-17T00:00:00.000Z',
        updated_at='2026-06-17T00:00:00.000Z'
    WHERE runner_kind!='research_plan_registered';
  `);

  const result = await runResearchPlanSchedulerOnce(new Date("2026-06-18T11:00:00"));
  assert.equal(result.checked, 6);
  assert.equal(result.started, 5);
  assert.equal(result.blocked, 0);
  assert.equal(result.runIds.length, 5);

  const dailyRun = db.querySql<{ id: string; status: string; metadata_json: string }>(
    "SELECT id, status, metadata_json FROM runs WHERE objective='Daily AI registered workflow run full flow' ORDER BY created_at DESC LIMIT 1"
  )[0];
  assert.ok(dailyRun);
  const metadata = JSON.parse(dailyRun.metadata_json) as {
    registeredWorkflowId?: string;
    registered_workflow_id?: string;
    workflowId?: string;
    workflow_id?: string;
    registered_workflow_start?: { source?: string; runnerKind?: string; dueKey?: string };
    worker_protocol?: string;
    worker_mode?: string;
    worker_loop?: { requiredCommand?: string };
    plan?: { approvalRequired?: boolean; tasks?: Array<{ adapter?: string }> };
  };
  assert.equal(metadata.registeredWorkflowId, "daily-ai-research-publish-run");
  assert.equal(metadata.registered_workflow_id, "daily-ai-research-publish-run");
  assert.equal(metadata.workflowId, "daily-ai-research-publish-run");
  assert.equal(metadata.workflow_id, "daily-ai-research-publish-run");
  assert.deepEqual(metadata.registered_workflow_start, {
    source: "scheduler",
    runnerKind: "daily_ai_registered",
    dueKey: "2026-06-18T09:00"
  });
  assert.equal(metadata.plan?.approvalRequired, false);
  assert.equal(metadata.plan?.tasks?.[0]?.adapter, "daily_ai_registered");
  assert.equal(dailyRun.status, "queued");
  assert.equal(metadata.worker_protocol, "local_worker_loop_required");
  assert.equal(metadata.worker_mode, "queued_for_local_worker_loop");
  assert.equal(metadata.worker_loop?.requiredCommand, "npm run worker:loop");
  assert.equal(db.querySql<{ count: number }>("SELECT count(*) AS count FROM worker_events WHERE run_id=" + db.sqlValue(dailyRun.id) + " AND event_type='queued_for_worker_loop'")[0].count, 1);

  const pendingApproval = db.querySql<{ id: string; status: string }>(
    `SELECT id, status FROM approvals WHERE run_id=${db.sqlValue(dailyRun.id)} ORDER BY created_at DESC LIMIT 1`
  )[0];
  assert.equal(pendingApproval, undefined);

  const workflow = db.querySql<{ provenance_json: string }>("SELECT provenance_json FROM registered_workflows WHERE id='daily-ai-research-publish-run'")[0];
  const provenance = JSON.parse(workflow.provenance_json) as { scheduler?: { lastRunId?: string; lastDueKey?: string; lastStartedAt?: string } };
  assert.equal(provenance.scheduler?.lastRunId, dailyRun.id);
  assert.equal(provenance.scheduler?.lastDueKey, "2026-06-18T09:00");
  assert.equal(typeof provenance.scheduler?.lastStartedAt, "string");

  const ledgerResponse = await getJson("/api/codex/automation-migration-ledger");
  const ledger = JSON.parse(ledgerResponse.body) as {
    items: Array<{
      registeredWorkflowId: string | null;
      scheduledOperationConfirmed: boolean;
      actualOperationConfirmed: boolean;
      proofConfirmed: boolean;
      latestRunId: string | null;
      latestRunStatus: string | null;
      remainingBlocker: string | null;
    }>;
  };
  const ledgerItem = ledger.items.find((item) => item.registeredWorkflowId === "daily-ai-research-publish-run");
  assert.equal(ledgerResponse.status, 200);
  assert.ok(ledgerItem);
  assert.equal(ledgerItem.latestRunId, dailyRun.id);
  assert.equal(ledgerItem.latestRunStatus, "queued");
  assert.equal(ledgerItem.scheduledOperationConfirmed, false);
  assert.equal(ledgerItem.actualOperationConfirmed, false);
  assert.equal(ledgerItem.proofConfirmed, false);
  assert.equal(ledgerItem.remainingBlocker, null);
});

test("registered workflow scheduler skips paused and inactive fixed registered workflows", async () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM registered_workflows;");
  await postJson("/api/registered-workflows/refresh", {});
  await postJson("/api/registered-workflows/daily-ai-research-publish-run/pause", {});
  db.execSql(`
    UPDATE registered_workflows
    SET status='inactive',
        created_at='2026-06-17T00:00:00.000Z',
        updated_at='2026-06-17T00:00:00.000Z'
    WHERE id='nisenprints-daily-product-canva-printify-etsy-pinterest';
  `);
  db.execSql(`
    UPDATE registered_workflows
    SET created_at='2026-06-17T00:00:00.000Z',
        updated_at='2026-06-17T00:00:00.000Z'
    WHERE id NOT IN ('daily-ai-research-publish-run', 'nisenprints-daily-product-canva-printify-etsy-pinterest');
  `);

  const result = await runResearchPlanSchedulerOnce(new Date("2026-06-18T11:00:00"));
  assert.equal(result.checked, 4);
  assert.equal(result.started, 3);
  assert.equal(db.querySql<{ count: number }>("SELECT count(*) AS count FROM runs WHERE objective='Daily AI registered workflow run full flow'")[0].count, 0);
  assert.equal(db.querySql<{ count: number }>("SELECT count(*) AS count FROM runs WHERE objective='NisenPrints registered workflow billing-only proof gate full publish'")[0].count, 0);
});

test("POST /api/obsidian/export exposes the existing guarded exporter", async () => {
  db.initDb();
  db.resetDemoData();
  const docsDir = join(tempRoot, "docs-for-api");
  const vaultPath = join(tempRoot, "vault-for-api");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "00-vision.md"), "# Vision\n\nAPI export.");
  mkdirSync(join(automationRoot, "api-export-automation"), { recursive: true });
  writeFileSync(join(automationRoot, "api-export-automation", "automation.toml"), "name = \"API export automation\"\n");

  const response = await postJson("/api/obsidian/export", { vaultPath, docsDir });
  const body = JSON.parse(response.body) as {
    ok: boolean;
    outputDir: string;
    files: string[];
    controlPanelFile: string;
    proofInboxFile: string;
    resumeContractFile: string;
    resumeContractJsonFile: string;
    missionFiles: string[];
    secondBrainFiles: string[];
    dashboardFiles: string[];
    projectGovernanceFiles: string[];
    orientationFiles: string[];
    templateFiles: string[];
  };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.ok(body.files.some((file) => file.endsWith("Automation OS Index.md")));
  assert.equal(body.files.length, 6);
  assert.ok(body.files.some((file) => file.endsWith("Run Ledger.md")));
  assert.ok(body.controlPanelFile.endsWith(join("01_Control Panel", "Automation Control Panel.md")));
  assert.ok(body.proofInboxFile.endsWith(join("04_Proof Pointers", "Proof Inbox.md")));
  assert.ok(body.resumeContractFile.endsWith(join("00_Start Here", "Resume Contract.md")));
  assert.ok(body.resumeContractJsonFile.endsWith("api-resume-contract.json"));
  assert.ok(body.missionFiles.length >= 10);
  assert.equal(body.dashboardFiles.length, 7);
  assert.ok(body.dashboardFiles.some((file) => file.endsWith(join("10_Dashboards", "Proof Dashboard.base"))));
  assert.ok(body.dashboardFiles.some((file) => file.endsWith(join("10_Dashboards", "Second Brain Review.base"))));
  assert.ok(body.dashboardFiles.some((file) => file.endsWith(join("10_Dashboards", "Blocker Radar.md"))));
  assert.ok(body.dashboardFiles.some((file) => file.endsWith(join("10_Dashboards", "Success Paths.md"))));
  assert.ok(body.projectGovernanceFiles.some((file) => file.endsWith(join("10_Dashboards", "Project Health.md"))));
  assert.ok(body.projectGovernanceFiles.some((file) => file.endsWith(join("data", "project-audit-status.json"))));
  assert.ok(body.missionFiles.some((file) => file.endsWith(join("00_Start Here", "Today.md"))));
  assert.ok(body.missionFiles.some((file) => file.endsWith(join("00_Start Here", "Codex Daily Brief.md"))));
  assert.ok(body.missionFiles.some((file) => file.endsWith(join("00_Start Here", "Project Cockpit.md"))));
  assert.ok(body.missionFiles.some((file) => file.endsWith(join("00_Start Here", "Resume Current Work.md"))));
  assert.ok(body.missionFiles.some((file) => file.endsWith(join("00_Start Here", "Resume Contract.md"))));
  assert.ok(body.missionFiles.some((file) => file.endsWith(join("01_Control Panel", "Action Queue.md"))));
  assert.ok(body.missionFiles.some((file) => file.endsWith(join("01_Control Panel", "Command Queue Intake.md"))));
  assert.ok(body.missionFiles.some((file) => file.endsWith(join("01_Control Panel", "Active Sessions.md"))));
  assert.ok(body.missionFiles.some((file) => file.endsWith(join("01_Control Panel", "Conversation Memory Cards.md"))));
  assert.ok(body.missionFiles.some((file) => file.endsWith(join("01_Control Panel", "User Signals.md"))));
  assert.ok(body.missionFiles.some((file) => file.endsWith(join("01_Control Panel", "Skill Registry.md"))));
  assert.ok(body.missionFiles.some((file) => file.endsWith(join("01_Control Panel", "Codex App Parity Ledger.md"))));
  assert.ok(body.missionFiles.some((file) => file.endsWith(join("00_Start Here", "Project Memory Map.md"))));
  assert.ok(body.missionFiles.some((file) => file.endsWith(join("07_Decisions", "Decision Log.md"))));
  assert.ok(body.missionFiles.some((file) => file.endsWith(join("07_Decisions", "Failure Fix Log.md"))));
  assert.ok(body.missionFiles.some((file) => file.endsWith(join("00_Start Here", "Weekly Review.md"))));
  assert.equal(body.secondBrainFiles.length, 3);
  assert.ok(body.secondBrainFiles.some((file) => file.endsWith(join("01_Control Panel", "Second Brain Intake.md"))));
  assert.ok(body.secondBrainFiles.some((file) => file.endsWith(join("01_Control Panel", "Second Brain Auto Processor.md"))));
  assert.ok(body.secondBrainFiles.some((file) => file.endsWith(join("00_Start Here", "Second Brain Weekly Digest.md"))));
  assert.equal(body.orientationFiles.length, 5);
  assert.ok(body.orientationFiles.some((file) => file.endsWith(join("05_Projects", "Project Index.md"))));
  assert.ok(body.orientationFiles.some((file) => file.endsWith(join("09_Inbox", "Inbox Index.md"))));
  assert.equal(body.templateFiles.length, 8);
  assert.ok(body.templateFiles.some((file) => file.endsWith(join("90_Templates", "project-note.md"))));
  assert.ok(body.templateFiles.some((file) => file.endsWith(join("90_Templates", "daily-url-capture.md"))));
  assert.ok(body.templateFiles.some((file) => file.endsWith(join("90_Templates", "thought-capture.md"))));
  assert.ok(body.templateFiles.some((file) => file.endsWith(join("90_Templates", "article-memo.md"))));
  assert.match(readFileSync(join(body.outputDir, "Docs.md"), "utf8"), /API export/);
  assert.match(readFileSync(body.controlPanelFile, "utf8"), /api-export-automation/);
  assert.match(readFileSync(body.resumeContractFile, "utf8"), /# Resume Contract/);
  assert.match(readFileSync(body.resumeContractJsonFile, "utf8"), /"resumeRule"/);
  assert.match(readFileSync(body.secondBrainFiles[0], "utf8"), /Second Brain/);
  assert.match(readFileSync(join(vaultPath, "01_Control Panel", "Second Brain Auto Processor.md"), "utf8"), /auto_approval_boundary: obsidian_internal_only/);
  assert.match(readFileSync(join(vaultPath, "10_Dashboards", "Second Brain Review.base"), "utf8"), /suggested_destination:/);
});

test("POST /api/obsidian/export keeps saved credential values out of Knowledge.md", async () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM stored_secrets; DELETE FROM knowledge_notes;");
  try {
    const tokenPrefix = "token_";
    const tokenMiddle = "1234567890abcdefghijklmnopqrstuvwxyz";
    const tokenSuffix = "WXYZ";
    const token = `${tokenPrefix}${tokenMiddle}${tokenSuffix}`;
    const docsDir = join(tempRoot, "docs-for-api-secrets");
    const vaultPath = join(tempRoot, "vault-for-api-secrets");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, "00-vision.md"), "# Vision\n\nCredential-safe export.");

    const saved = secrets.saveSecretsFromMessage(`OpenAI APIキーは ${token} です`);
    const refresh = knowledge.refreshKnowledgeNotes();
    const response = await postJson("/api/obsidian/export", { vaultPath, docsDir });
    const body = JSON.parse(response.body) as { ok: boolean; outputDir: string };
    const knowledgeMarkdown = readFileSync(join(body.outputDir, "Knowledge.md"), "utf8");
    const maskedValue = saved.stored[0].maskedValue;

    assert.equal(saved.stored.length, 1);
    assert.equal(refresh.ok, true);
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.match(knowledgeMarkdown, /OpenAI APIキー: saved, value hidden/);
    assert.equal(knowledgeMarkdown.includes(token), false, "Knowledge.md must not contain the raw saved token");
    assert.equal(knowledgeMarkdown.includes(tokenPrefix), false, "Knowledge.md must not contain saved token prefixes");
    assert.equal(knowledgeMarkdown.includes(tokenMiddle), false, "Knowledge.md must not contain saved token middle fragments");
    assert.equal(knowledgeMarkdown.includes(tokenSuffix), false, "Knowledge.md must not contain saved token suffixes");
    assert.equal(knowledgeMarkdown.includes(maskedValue), false, "Knowledge.md must not contain masked credential values");
    assert.equal(knowledgeMarkdown.includes("maskedValue"), false, "Knowledge.md must not expose credential summary fields");
  } finally {
    db.execSql("DELETE FROM stored_secrets; DELETE FROM knowledge_notes;");
  }
});

test("POST /api/obsidian/export rejects custom paths unless explicitly allowed", async () => {
  db.initDb();
  db.resetDemoData();
  const previous = process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT;
  process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT = "0";
  try {
    const response = await postJson("/api/obsidian/export", { vaultPath: join(tempRoot, "blocked-vault") });
    const body = JSON.parse(response.body) as { error: string };

    assert.equal(response.status, 403);
    assert.equal(body.error, "obsidian_custom_export_requires_approval");
  } finally {
    process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT = previous;
  }
});

test("POST /api/obsidian/ingest writes an inbox note and triggers auto export on success", async () => {
  db.initDb();
  db.resetDemoData();
  const previousAutoExport = process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT;
  const previousVault = process.env.AUTOMATION_OS_OBSIDIAN_VAULT;
  const previousStatusFile = process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE;
  const vaultPath = join(tempRoot, "ingest-api-vault");
  const statusFile = join(tempRoot, "ingest-api-status.json");
  mkdirSync(join(vaultPath, "09_Inbox"), { recursive: true });
  process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT = "1";
  process.env.AUTOMATION_OS_OBSIDIAN_VAULT = vaultPath;
  process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE = statusFile;

  try {
    const response = await postJson("/api/obsidian/ingest", {
      vaultPath,
      sourceUrl: "https://example.com/api",
      sourceTitle: "API Capture",
      sourceType: "article",
      text: "API body",
      capturedAt: "2026-06-14T05:00:00.000Z"
    });
    const body = JSON.parse(response.body) as { ok: boolean; file: string; path: string };
    const status = JSON.parse(readFileSync(statusFile, "utf8")) as { ok: boolean; reason: string };

    assert.equal(response.status, 201);
    assert.equal(body.ok, true);
    assert.equal(body.file, join("09_Inbox", "API-Capture.md"));
    assert.match(readFileSync(body.path, "utf8"), /source_type: "article"/);
    assert.equal(status.ok, true);
    assert.equal(status.reason, "obsidian-ingested");
  } finally {
    if (previousAutoExport === undefined) delete process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT;
    else process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT = previousAutoExport;
    if (previousVault === undefined) delete process.env.AUTOMATION_OS_OBSIDIAN_VAULT;
    else process.env.AUTOMATION_OS_OBSIDIAN_VAULT = previousVault;
    if (previousStatusFile === undefined) delete process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE;
    else process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE = previousStatusFile;
  }
});

test("POST /api/obsidian/ingest rejects caller-controlled file write inputs", async () => {
  db.initDb();
  db.resetDemoData();

  const response = await postJson("/api/obsidian/ingest", {
    sourceTitle: "API Capture",
    sourceType: "article",
    text: "API body",
    statusFile: join(tempRoot, "ingest-api-body-status-rejected.json")
  });

  assert.equal(response.status, 400);
  assert.deepEqual(JSON.parse(response.body), {
    ok: false,
    status: "rejected",
    exactBlocker: "obsidian_ingest_file_write_input_not_allowed",
    summary: "statusFile, artifactRoot, artifactDir, responseFile, contentFile, manifestFile, and blockerFile are not accepted by this API"
  });
});

test("POST /api/obsidian/ingest rejects custom vaults unless explicitly allowed", async () => {
  db.initDb();
  db.resetDemoData();
  const previous = process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT;
  process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT = "0";
  try {
    const response = await postJson("/api/obsidian/ingest", {
      vaultPath: join(tempRoot, "ingest-api-blocked-vault"),
      sourceType: "note",
      text: "blocked"
    });
    const body = JSON.parse(response.body) as { ok: boolean; error: string };

    assert.equal(response.status, 403);
    assert.equal(body.ok, false);
    assert.equal(body.error, "obsidian_custom_export_requires_approval");
  } finally {
    process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT = previous;
  }
});

test("POST /api/obsidian/url-capture fetches readable content and writes a url_capture note", async () => {
  db.initDb();
  db.resetDemoData();
  const previousVault = process.env.AUTOMATION_OS_OBSIDIAN_VAULT;
  const vaultPath = join(tempRoot, "url-capture-api-vault");
  mkdirSync(join(vaultPath, "09_Inbox"), { recursive: true });
  process.env.AUTOMATION_OS_OBSIDIAN_VAULT = vaultPath;
  urlCapture.setUrlCaptureFetchImplForTests(
    async (target) => {
      assert.equal(target.url.toString(), "https://example.com/api-capture");
      assert.equal(target.address, "93.184.216.34");
      return new Response("<html><head><title>API URL Capture</title></head><body><p>Readable API capture.</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    },
    async () => ["93.184.216.34"]
  );

  try {
    const response = await postJson("/api/obsidian/url-capture", {
      url: "https://example.com/api-capture",
      statusFile: join(tempRoot, "must-be-rejected-if-sent.json")
    });
    const rejected = JSON.parse(response.body) as { exactBlocker: string };
    assert.equal(response.status, 400);
    assert.equal(rejected.exactBlocker, "url_capture_file_write_input_not_allowed");

    const okResponse = await postJson("/api/obsidian/url-capture", {
      url: "https://example.com/api-capture"
    });
    const body = JSON.parse(okResponse.body) as { ok: boolean; status: string; ingest: { file: string; path: string; sourceType: string } };

    assert.equal(okResponse.status, 201);
    assert.equal(body.ok, true);
    assert.equal(body.status, "captured");
    assert.equal(body.ingest.sourceType, "url_capture");
    assert.equal(body.ingest.file, join("09_Inbox", "API-URL-Capture.md"));
    assert.match(readFileSync(body.ingest.path, "utf8"), /Readable API capture/);
  } finally {
    urlCapture.setUrlCaptureFetchImplForTests(undefined, undefined);
    if (previousVault === undefined) delete process.env.AUTOMATION_OS_OBSIDIAN_VAULT;
    else process.env.AUTOMATION_OS_OBSIDIAN_VAULT = previousVault;
  }
});

test("POST /api/obsidian/url-capture returns 202 after creating blocker note for blocked content", async () => {
  db.initDb();
  db.resetDemoData();
  const previousVault = process.env.AUTOMATION_OS_OBSIDIAN_VAULT;
  const vaultPath = join(tempRoot, "url-capture-api-blocked-vault");
  mkdirSync(join(vaultPath, "09_Inbox"), { recursive: true });
  process.env.AUTOMATION_OS_OBSIDIAN_VAULT = vaultPath;
  urlCapture.setUrlCaptureFetchImplForTests(
    async () =>
      new Response("Login required to continue", {
        status: 401,
        headers: { "content-type": "text/plain" }
      }),
    async () => ["93.184.216.34"]
  );

  try {
    const response = await postJson("/api/obsidian/url-capture", {
      url: "https://example.com/private"
    });
    const body = JSON.parse(response.body) as {
      ok: boolean;
      status: string;
      exactBlocker: string;
      artifactDir: string;
      ingest: { path: string; sourceType: string };
    };

    assert.equal(response.status, 202);
    assert.equal(body.ok, false);
    assert.equal(body.status, "blocked");
    assert.equal(body.exactBlocker, "url_capture_http_401");
    assert.equal(body.ingest.sourceType, "url_capture_blocked");
    assert.equal(existsSync(join(body.artifactDir, "manifest.json")), true);
    assert.match(readFileSync(body.ingest.path, "utf8"), /Exact blocker: url_capture_http_401/);
  } finally {
    urlCapture.setUrlCaptureFetchImplForTests(undefined, undefined);
    if (previousVault === undefined) delete process.env.AUTOMATION_OS_OBSIDIAN_VAULT;
    else process.env.AUTOMATION_OS_OBSIDIAN_VAULT = previousVault;
  }
});

test("POST /api/obsidian/url-capture rejects custom vaults before fetch", async () => {
  db.initDb();
  db.resetDemoData();
  const previousAllow = process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT;
  process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT = "0";
  let fetchCount = 0;
  urlCapture.setUrlCaptureFetchImplForTests(
    async () => {
      fetchCount += 1;
      return new Response("must not fetch");
    },
    async () => ["93.184.216.34"]
  );
  try {
    const response = await postJson("/api/obsidian/url-capture", {
      url: "https://example.com/custom-vault",
      vaultPath: join(tempRoot, "url-capture-api-custom-vault")
    });
    const body = JSON.parse(response.body) as { ok: boolean; status: string; exactBlocker: string };

    assert.equal(response.status, 403);
    assert.equal(body.ok, false);
    assert.equal(body.status, "rejected");
    assert.equal(body.exactBlocker, "obsidian_custom_export_requires_approval");
    assert.equal(fetchCount, 0);
  } finally {
    urlCapture.setUrlCaptureFetchImplForTests(undefined, undefined);
    process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT = previousAllow;
  }
});

test("POST /api/obsidian/export treats empty custom path fields as custom requests", async () => {
  db.initDb();
  db.resetDemoData();
  const previous = process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT;
  process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT = "0";
  try {
    for (const payload of [{ outputSubdir: "" }, { docsDir: "" }]) {
      const response = await postJson("/api/obsidian/export", payload);
      const body = JSON.parse(response.body) as { error: string };

      assert.equal(response.status, 403);
      assert.equal(body.error, "obsidian_custom_export_requires_approval");
    }
  } finally {
    process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT = previous;
  }
});

test("GET /api/browser/health reports local Playwright and Codex Browser bridge boundary", async () => {
  const ok = await getJson("/api/browser/health");
  const okBody = JSON.parse(ok.body) as {
    browserUseRecordingQa: {
      status: string;
      exactBlocker: string | null;
      userSummary: string;
      nextAction: string;
      builtinSidecarAvailable: boolean;
      ffmpegAvailable: boolean;
      geminiQaRunnerConfigured: boolean;
      cdpLaneConfigured: boolean;
    };
    codexBrowserBridge: { status: string; directCallableFromLocalApp: boolean };
    localApp: { canReportHealth: boolean };
  };
  assert.equal(ok.status, 200);
  assert.equal(okBody.codexBrowserBridge.status, "requires_bridge");
  assert.equal(okBody.codexBrowserBridge.directCallableFromLocalApp, false);
  assert.equal(okBody.localApp.canReportHealth, true);
  assert.equal(typeof okBody.browserUseRecordingQa.userSummary, "string");
  assert.equal(typeof okBody.browserUseRecordingQa.nextAction, "string");
  assert.equal(typeof okBody.browserUseRecordingQa.builtinSidecarAvailable, "boolean");
  assert.equal(typeof okBody.browserUseRecordingQa.ffmpegAvailable, "boolean");
  assert.equal(typeof okBody.browserUseRecordingQa.geminiQaRunnerConfigured, "boolean");
  assert.equal(typeof okBody.browserUseRecordingQa.cdpLaneConfigured, "boolean");
});

test("GET /api/browser/health reports Browser Use recording QA callable-surface blocker first", async () => {
  const restore = installBrowserUseRecordingQaHealthEnv({
    browserUseCli: "",
    recordingSidecar: join(tempRoot, "unused-recording-sidecar.sh"),
    geminiRunner: join(tempRoot, "unused-gemini-runner.sh"),
    cdpUrl: "http://127.0.0.1:9333",
    fakeFfmpeg: true
  });
  try {
    const response = await getJson("/api/browser/health");
    const body = JSON.parse(response.body) as {
      browserUseCli: { status: string; command: string | null };
      browserUseRecordingQa: { status: string; exactBlocker: string | null; userSummary: string; nextAction: string };
    };

    assert.equal(response.status, 200);
    assert.equal(body.browserUseCli.status, "missing");
    assert.equal(body.browserUseCli.command, null);
    assert.equal(body.browserUseRecordingQa.status, "blocked");
    assert.equal(body.browserUseRecordingQa.exactBlocker, "browser_use_callable_surface_missing");
    assert.match(body.browserUseRecordingQa.userSummary, /Browser Use/);
    assert.match(body.browserUseRecordingQa.nextAction, /AUTOMATION_OS_BROWSER_USE_CLI/);
  } finally {
    restore();
  }
});

test("GET /api/browser/health reports Browser Use recording QA ready when every operator input is configured", async () => {
  const restore = installBrowserUseRecordingQaHealthEnv({
    browserUseCli: join(tempRoot, "health-node.sh"),
    recordingSidecar: join(tempRoot, "health-recording-sidecar.sh"),
    geminiRunner: join(tempRoot, "health-gemini-runner.sh"),
    cdpUrl: "http://127.0.0.1:9333",
    geminiApiKey: "test-gemini-key",
    fakeFfmpeg: true
  });
  try {
    const response = await getJson("/api/browser/health");
    const body = JSON.parse(response.body) as {
      browserUseRecordingQa: {
        status: string;
        exactBlocker: string | null;
        userSummary: string;
        nextAction: string;
        builtinSidecarAvailable: boolean;
        ffmpegAvailable: boolean;
        geminiQaRunnerConfigured: boolean;
        cdpLaneConfigured: boolean;
      };
    };

    assert.equal(response.status, 200);
    assert.equal(body.browserUseRecordingQa.status, "ready");
    assert.equal(body.browserUseRecordingQa.exactBlocker, null);
    assert.match(body.browserUseRecordingQa.userSummary, /準備ができています/);
    assert.match(body.browserUseRecordingQa.nextAction, /このまま/);
    assert.equal(body.browserUseRecordingQa.builtinSidecarAvailable, true);
    assert.equal(body.browserUseRecordingQa.ffmpegAvailable, true);
    assert.equal(body.browserUseRecordingQa.geminiQaRunnerConfigured, true);
    assert.equal(body.browserUseRecordingQa.cdpLaneConfigured, true);
  } finally {
    restore();
  }
});

test("GET /api/browser/health blocks Browser Use recording QA when Gemini key is missing", async () => {
  const restore = installBrowserUseRecordingQaHealthEnv({
    browserUseCli: join(tempRoot, "health-node-key-missing.sh"),
    recordingSidecar: join(tempRoot, "health-recording-sidecar-key-missing.sh"),
    geminiRunner: join(tempRoot, "health-gemini-runner-key-missing.sh"),
    cdpUrl: "http://127.0.0.1:9333",
    geminiApiKey: "",
    fakeFfmpeg: true
  });
  try {
    const response = await getJson("/api/browser/health");
    const body = JSON.parse(response.body) as {
      browserUseRecordingQa: { status: string; exactBlocker: string | null; userSummary: string; nextAction: string };
    };

    assert.equal(response.status, 200);
    assert.equal(body.browserUseRecordingQa.status, "blocked");
    assert.equal(body.browserUseRecordingQa.exactBlocker, "browser_use_gemini_api_key_missing");
    assert.match(body.browserUseRecordingQa.userSummary, /Gemini/);
    assert.match(body.browserUseRecordingQa.nextAction, /Gemini/);
  } finally {
    restore();
  }
});

test("GET /api/browser/health blocks Browser Use recording QA when configured runner path is missing", async () => {
  const restore = installBrowserUseRecordingQaHealthEnv({
    browserUseCli: join(tempRoot, "health-node-runner-missing.sh"),
    recordingSidecar: join(tempRoot, "health-recording-sidecar-runner-missing.sh"),
    geminiRunner: join(tempRoot, "missing-health-gemini-runner.sh"),
    cdpUrl: "http://127.0.0.1:9333",
    geminiApiKey: "test-gemini-key",
    fakeFfmpeg: true,
    createGeminiRunnerExecutable: false
  });
  try {
    const response = await getJson("/api/browser/health");
    const body = JSON.parse(response.body) as {
      browserUseRecordingQa: { status: string; exactBlocker: string | null };
    };

    assert.equal(response.status, 200);
    assert.equal(body.browserUseRecordingQa.status, "blocked");
    assert.equal(body.browserUseRecordingQa.exactBlocker, "browser_use_gemini_video_qa_runner_missing");
  } finally {
    restore();
  }
});

test("POST local browser check leaves dashboard responsive while Playwright CLI is running", async () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM system_checks; DELETE FROM bridge_actions;");
  const restorePlaywrightCli = installSlowPlaywrightFakeCli("node-dashboard-responsive", 200);

  try {
    let checkFinished = false;
    const checkPromise = postJson("/api/bridge/actions/local_browser_check/run", {
      targetUrl: "http://127.0.0.1:5173/#sources"
    }).then((response) => {
      checkFinished = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const dashboardResponse = await getJson("/api/dashboard");
    assert.equal(checkFinished, false, "dashboard should respond before the browser check request finishes");

    const checkResponse = await checkPromise;
    const checkBody = JSON.parse(checkResponse.body) as {
      status: string;
      systemCheck: {
        driver: string;
        status: string;
        metadata: { driver: string; missingArtifacts: string[]; artifactValidationStatus: string };
      };
    };

    assert.equal(dashboardResponse.status, 200);
    assert.equal(checkResponse.status, 200);
    assert.equal(checkBody.status, "ok");
    assert.equal(checkBody.systemCheck.driver, "playwright_cli");
    assert.equal(checkBody.systemCheck.status, "ok");
    assert.equal(checkBody.systemCheck.metadata.driver, "playwright_cli");
    assert.deepEqual(checkBody.systemCheck.metadata.missingArtifacts, []);
    assert.equal(checkBody.systemCheck.metadata.artifactValidationStatus, "ok");
  } finally {
    restorePlaywrightCli();
  }
});

test("POST browser-check endpoint also leaves dashboard responsive while Playwright CLI is running", async () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM system_checks; DELETE FROM bridge_actions;");
  const restorePlaywrightCli = installSlowPlaywrightFakeCli("node-dashboard-responsive-direct", 200);

  try {
    let checkFinished = false;
    const checkPromise = postJson("/api/bridge/browser-check", {
      targetUrl: "http://127.0.0.1:5173/#sources"
    }).then((response) => {
      checkFinished = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const dashboardResponse = await getJson("/api/dashboard");
    assert.equal(checkFinished, false, "dashboard should respond before the direct browser check request finishes");

    const checkResponse = await checkPromise;
    const checkBody = JSON.parse(checkResponse.body) as {
      driver: string;
      status: string;
      metadata: { driver: string; missingArtifacts: string[]; artifactValidationStatus: string };
    };

    assert.equal(dashboardResponse.status, 200);
    assert.equal(checkResponse.status, 200);
    assert.equal(checkBody.driver, "playwright_cli");
    assert.equal(checkBody.status, "ok");
    assert.equal(checkBody.metadata.driver, "playwright_cli");
    assert.deepEqual(checkBody.metadata.missingArtifacts, []);
    assert.equal(checkBody.metadata.artifactValidationStatus, "ok");
  } finally {
    restorePlaywrightCli();
  }
});

test("POST /api/bridge/node-check blocks lane observations until recording QA is connected", async () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM system_checks; DELETE FROM bridge_actions;");
  const previousCli = process.env.AUTOMATION_OS_BROWSER_USE_CLI;
  const previousArtifactDir = process.env.AUTOMATION_OS_BROWSER_USE_ARTIFACT_DIR;
  const browserUseCli = join(tempRoot, "node-api-test.sh");
  writeFileSync(
    browserUseCli,
    `#!/bin/sh
set -eu
last=""
for arg in "$@"; do last="$arg"; done
case " $* " in
  *" state "*) printf '%s\\n' 'url: http://127.0.0.1:5173/#lanes';;
  *" screenshot "*) printf '%s' 'png' > "$last"; printf '%s\\n' 'saved screenshot';;
  *" open "*) printf '%s\\n' 'opened';;
  *) printf '%s\\n' 'ok';;
esac
`,
    "utf8"
  );
  chmodSync(browserUseCli, 0o755);
  process.env.AUTOMATION_OS_BROWSER_USE_CLI = browserUseCli;
  process.env.AUTOMATION_OS_BROWSER_USE_ARTIFACT_DIR = join(tempRoot, "node-api-artifacts");
  const now = "2026-06-12T00:00:00.000Z";
  db.insert("runs", {
    id: "run_api_lane",
    name: "Browser Use lane API run",
    status: "running",
    objective: "Record Browser Use lane observation",
    created_at: now,
    updated_at: now,
    metadata_json: {}
  });
  db.insert("lanes", {
    id: "lane_api_observed",
    run_id: "run_api_lane",
    role: "browser",
    cdp_port: 9444,
    profile_dir: "/tmp/profile-api",
    workdir: "/tmp/workdir-api",
    browser_use_session: "node-api-lane",
    browser_use_cdp_url: "http://127.0.0.1:9444",
    browser_use_profile: "/tmp/profile-api",
    profile_strategy: "cdp_profile_lane",
    lane_visibility: "visible",
    status: "active",
    current_task: "Browser Use lane check",
    progress: 50,
    health: "unknown",
    resource_locks_json: ["browser_lane"],
    updated_at: "2026-06-11T00:00:00.000Z"
  });

  try {
    const response = await postJson("/api/bridge/node-check", {
      laneId: "lane_api_observed",
      targetUrl: "http://127.0.0.1:5173/#lanes"
    });
    const body = JSON.parse(response.body) as {
      status: string;
      createdAt: string;
      metadata: {
        session: string;
        connectionStrategy: { cdpUrl: string; profile: string };
        recordingQa: { reason: string; recorderStatus: string };
      };
    };
    const lane = db.querySql<{
      browser_use_session: string;
      browser_use_cdp_url: string;
      browser_use_profile: string;
      profile_strategy: string;
      lane_visibility: string;
      health: string;
      updated_at: string;
    }>("SELECT * FROM lanes WHERE id='lane_api_observed'")[0];
    const dashboard = JSON.parse((await getJson("/api/dashboard")).body) as { lanes: Array<{ id: string; run_name: string; run_status: string; updated_at: string }> };

    assert.equal(response.status, 200);
    assert.equal(body.status, "blocked");
    assert.equal(body.metadata.session, "node-api-lane");
    assert.equal(body.metadata.connectionStrategy.cdpUrl, "http://127.0.0.1:9444");
    assert.equal(body.metadata.connectionStrategy.profile, "/tmp/profile-api");
    assert.equal(body.metadata.recordingQa.reason, "browser_use_recording_recorder_unavailable");
    assert.equal(body.metadata.recordingQa.recorderStatus, "planned");
    assert.equal(lane.browser_use_session, "node-api-lane");
    assert.equal(lane.browser_use_cdp_url, "http://127.0.0.1:9444");
    assert.equal(lane.browser_use_profile, "/tmp/profile-api");
    assert.equal(lane.profile_strategy, "cdp_profile_lane");
    assert.equal(lane.lane_visibility, "visible");
    assert.equal(lane.health, "blocked");
    assert.equal(lane.updated_at, body.createdAt);
    assert.equal(dashboard.lanes[0].id, "lane_api_observed");
    assert.equal(dashboard.lanes[0].run_name, "Browser Use lane API run");
    assert.equal(dashboard.lanes[0].run_status, "running");
    assert.equal(dashboard.lanes[0].updated_at, body.createdAt);
  } finally {
    if (previousCli === undefined) delete process.env.AUTOMATION_OS_BROWSER_USE_CLI;
    else process.env.AUTOMATION_OS_BROWSER_USE_CLI = previousCli;
    if (previousArtifactDir === undefined) delete process.env.AUTOMATION_OS_BROWSER_USE_ARTIFACT_DIR;
    else process.env.AUTOMATION_OS_BROWSER_USE_ARTIFACT_DIR = previousArtifactDir;
  }
});

test("POST /api/bridge/node-check records blocked lane observations resolved by cdpPort", async () => {
  db.initDb();
  db.resetDemoData();
  const previousCli = process.env.AUTOMATION_OS_BROWSER_USE_CLI;
  const previousArtifactDir = process.env.AUTOMATION_OS_BROWSER_USE_ARTIFACT_DIR;
  process.env.AUTOMATION_OS_BROWSER_USE_CLI = "";
  process.env.AUTOMATION_OS_BROWSER_USE_ARTIFACT_DIR = join(tempRoot, "node-api-blocked-artifacts");
  const now = "2026-06-12T00:10:00.000Z";
  db.insert("runs", {
    id: "run_api_blocked",
    name: "Blocked Browser Use lane",
    status: "running",
    objective: "Record blocked lane observation",
    created_at: now,
    updated_at: now,
    metadata_json: {}
  });
  db.insert("lanes", {
    id: "lane_api_blocked",
    run_id: "run_api_blocked",
    role: "browser",
    cdp_port: 9445,
    profile_dir: "/tmp/profile-blocked",
    workdir: "/tmp/workdir-blocked",
    browser_use_session: "node-blocked-lane",
    browser_use_cdp_url: "http://127.0.0.1:9445",
    browser_use_profile: "/tmp/profile-blocked",
    profile_strategy: "cdp_profile_lane",
    lane_visibility: "visible",
    status: "active",
    current_task: "Browser Use blocked check",
    progress: 50,
    health: "unknown",
    resource_locks_json: ["browser_lane"],
    updated_at: "2026-06-11T00:10:00.000Z"
  });

  try {
    const response = await postJson("/api/bridge/node-check", {
      cdpPort: 9445,
      targetUrl: "http://127.0.0.1:5173/#lanes"
    });
    const body = JSON.parse(response.body) as { status: string; createdAt: string; metadata: { session: string; connectionStrategy: { cdpUrl: string; profile: string } } };
    const lane = db.querySql<{ health: string; updated_at: string; browser_use_session: string; browser_use_cdp_url: string; browser_use_profile: string }>(
      "SELECT * FROM lanes WHERE id='lane_api_blocked'"
    )[0];

    assert.equal(response.status, 200);
    assert.equal(body.status, "blocked");
    assert.equal(body.metadata.session, "node-blocked-lane");
    assert.equal(body.metadata.connectionStrategy.cdpUrl, "http://127.0.0.1:9445");
    assert.equal(body.metadata.connectionStrategy.profile, "/tmp/profile-blocked");
    assert.equal(lane.health, "blocked");
    assert.equal(lane.updated_at, body.createdAt);
    assert.equal(lane.browser_use_session, "node-blocked-lane");
    assert.equal(lane.browser_use_cdp_url, "http://127.0.0.1:9445");
    assert.equal(lane.browser_use_profile, "/tmp/profile-blocked");
  } finally {
    if (previousCli === undefined) delete process.env.AUTOMATION_OS_BROWSER_USE_CLI;
    else process.env.AUTOMATION_OS_BROWSER_USE_CLI = previousCli;
    if (previousArtifactDir === undefined) delete process.env.AUTOMATION_OS_BROWSER_USE_ARTIFACT_DIR;
    else process.env.AUTOMATION_OS_BROWSER_USE_ARTIFACT_DIR = previousArtifactDir;
  }
});

test("POST /api/bridge/node-check does not update a lane when laneId conflicts with profile", async () => {
  db.initDb();
  db.resetDemoData();
  const restoreBrowserUseCli = installBrowserUseFakeCli("node-laneid-conflict");
  const now = "2026-06-12T00:20:00.000Z";
  db.insert("runs", {
    id: "run_api_laneid_conflict",
    name: "Browser Use laneId conflict",
    status: "running",
    objective: "Do not cross-write lane observations",
    created_at: now,
    updated_at: now,
    metadata_json: {}
  });
  insertBrowserUseLane({
    id: "lane_api_laneid_conflict_a",
    runId: "run_api_laneid_conflict",
    cdpPort: 9450,
    profile: "/tmp/profile-laneid-conflict-a",
    session: "node-laneid-conflict-a",
    updatedAt: "2026-06-11T00:20:00.000Z"
  });
  insertBrowserUseLane({
    id: "lane_api_laneid_conflict_b",
    runId: "run_api_laneid_conflict",
    cdpPort: 9451,
    profile: "/tmp/profile-laneid-conflict-b",
    session: "node-laneid-conflict-b",
    updatedAt: "2026-06-11T00:21:00.000Z"
  });

  try {
    const response = await postJson("/api/bridge/node-check", {
      laneId: "lane_api_laneid_conflict_a",
      profile: "/tmp/profile-laneid-conflict-b",
      targetUrl: "http://127.0.0.1:5173/#lanes"
    });
    const body = JSON.parse(response.body) as {
      status: string;
      metadata: {
        session: string;
        connectionStrategy: { profile: string };
        recordingQa: { reason: string; recorderStatus: string };
      };
    };
    const lanes = db.querySql<{ id: string; health: string; updated_at: string }>("SELECT id, health, updated_at FROM lanes WHERE run_id='run_api_laneid_conflict' ORDER BY id");

    assert.equal(response.status, 200);
    assert.equal(body.status, "blocked");
    assert.notEqual(body.metadata.session, "node-laneid-conflict-a");
    assert.equal(body.metadata.connectionStrategy.profile, "/tmp/profile-laneid-conflict-b");
    assert.equal(body.metadata.recordingQa.reason, "browser_use_recording_requires_cdp_lane");
    assert.equal(body.metadata.recordingQa.recorderStatus, "unavailable");
    assert.deepEqual(lanes, [
      { id: "lane_api_laneid_conflict_a", health: "unknown", updated_at: "2026-06-11T00:20:00.000Z" },
      { id: "lane_api_laneid_conflict_b", health: "unknown", updated_at: "2026-06-11T00:21:00.000Z" }
    ]);
  } finally {
    restoreBrowserUseCli();
  }
});

test("POST /api/bridge/node-check does not update a lane when cdpUrl and profile resolve to different lanes", async () => {
  db.initDb();
  db.resetDemoData();
  const restoreBrowserUseCli = installBrowserUseFakeCli("node-identifier-conflict");
  const now = "2026-06-12T00:30:00.000Z";
  db.insert("runs", {
    id: "run_api_identifier_conflict",
    name: "Browser Use identifier conflict",
    status: "running",
    objective: "Do not resolve conflicting identifiers",
    created_at: now,
    updated_at: now,
    metadata_json: {}
  });
  insertBrowserUseLane({
    id: "lane_api_identifier_conflict_a",
    runId: "run_api_identifier_conflict",
    cdpPort: 9460,
    profile: "/tmp/profile-identifier-conflict-a",
    session: "node-identifier-conflict-a",
    updatedAt: "2026-06-11T00:30:00.000Z"
  });
  insertBrowserUseLane({
    id: "lane_api_identifier_conflict_b",
    runId: "run_api_identifier_conflict",
    cdpPort: 9461,
    profile: "/tmp/profile-identifier-conflict-b",
    session: "node-identifier-conflict-b",
    updatedAt: "2026-06-11T00:31:00.000Z"
  });

  try {
    const response = await postJson("/api/bridge/node-check", {
      cdpUrl: "http://127.0.0.1:9460",
      profile: "/tmp/profile-identifier-conflict-b",
      targetUrl: "http://127.0.0.1:5173/#lanes"
    });
    const body = JSON.parse(response.body) as {
      status: string;
      metadata: {
        session: string;
        connectionStrategy: { cdpUrl: string; profile: string };
        recordingQa: { reason: string; recorderStatus: string };
      };
    };
    const lanes = db.querySql<{ id: string; health: string; updated_at: string }>("SELECT id, health, updated_at FROM lanes WHERE run_id='run_api_identifier_conflict' ORDER BY id");

    assert.equal(response.status, 200);
    assert.equal(body.status, "blocked");
    assert.notEqual(body.metadata.session, "node-identifier-conflict-a");
    assert.notEqual(body.metadata.session, "node-identifier-conflict-b");
    assert.equal(body.metadata.connectionStrategy.cdpUrl, "http://127.0.0.1:9460");
    assert.equal(body.metadata.connectionStrategy.profile, "/tmp/profile-identifier-conflict-b");
    assert.equal(body.metadata.recordingQa.reason, "browser_use_recording_recorder_unavailable");
    assert.equal(body.metadata.recordingQa.recorderStatus, "planned");
    assert.deepEqual(lanes, [
      { id: "lane_api_identifier_conflict_a", health: "unknown", updated_at: "2026-06-11T00:30:00.000Z" },
      { id: "lane_api_identifier_conflict_b", health: "unknown", updated_at: "2026-06-11T00:31:00.000Z" }
    ]);
  } finally {
    restoreBrowserUseCli();
  }
});

test("POST /api/bridge/node-check resolves matching cdpUrl and profile to the same lane but blocks without recorder QA", async () => {
  db.initDb();
  db.resetDemoData();
  const restoreBrowserUseCli = installBrowserUseFakeCli("node-cdp-profile-positive");
  const now = "2026-06-12T00:40:00.000Z";
  db.insert("runs", {
    id: "run_api_cdp_profile_positive",
    name: "Browser Use cdp/profile positive",
    status: "running",
    objective: "Resolve matching Browser Use identifiers",
    created_at: now,
    updated_at: now,
    metadata_json: {}
  });
  insertBrowserUseLane({
    id: "lane_api_cdp_profile_positive",
    runId: "run_api_cdp_profile_positive",
    cdpPort: 9470,
    profile: "/tmp/profile-cdp-profile-positive",
    session: "node-cdp-profile-positive",
    updatedAt: "2026-06-11T00:40:00.000Z"
  });

  try {
    const response = await postJson("/api/bridge/node-check", {
      cdpUrl: "http://localhost:9470/",
      profile: "/tmp/profile-cdp-profile-positive",
      targetUrl: "http://127.0.0.1:5173/#lanes"
    });
    const body = JSON.parse(response.body) as {
      status: string;
      createdAt: string;
      metadata: {
        session: string;
        connectionStrategy: { cdpUrl: string; profile: string };
        recordingQa: { reason: string; recorderStatus: string };
      };
    };
    const lane = db.querySql<{ health: string; updated_at: string; browser_use_session: string; browser_use_cdp_url: string; browser_use_profile: string }>(
      "SELECT health, updated_at, browser_use_session, browser_use_cdp_url, browser_use_profile FROM lanes WHERE id='lane_api_cdp_profile_positive'"
    )[0];

    assert.equal(response.status, 200);
    assert.equal(body.status, "blocked");
    assert.equal(body.metadata.session, "node-cdp-profile-positive");
    assert.equal(body.metadata.connectionStrategy.cdpUrl, "http://127.0.0.1:9470");
    assert.equal(body.metadata.connectionStrategy.profile, "/tmp/profile-cdp-profile-positive");
    assert.equal(body.metadata.recordingQa.reason, "browser_use_recording_recorder_unavailable");
    assert.equal(body.metadata.recordingQa.recorderStatus, "planned");
    assert.equal(lane.health, "blocked");
    assert.equal(lane.updated_at, body.createdAt);
    assert.equal(lane.browser_use_session, "node-cdp-profile-positive");
    assert.equal(lane.browser_use_cdp_url, "http://127.0.0.1:9470");
    assert.equal(lane.browser_use_profile, "/tmp/profile-cdp-profile-positive");
  } finally {
    restoreBrowserUseCli();
  }
});

test("POST /api/bridge/node-check marks a lane good when recording and Gemini QA sidecar are present", async () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM system_checks; DELETE FROM bridge_actions;");
  const restoreBrowserUseCli = installBrowserUseSidecarFakeCli("node-cdp-profile-sidecar-ok");
  const now = "2026-06-12T00:45:00.000Z";
  db.insert("runs", {
    id: "run_api_cdp_profile_sidecar_ok",
    name: "Browser Use cdp/profile sidecar ok",
    status: "running",
    objective: "Resolve matching Browser Use identifiers with recording QA",
    created_at: now,
    updated_at: now,
    metadata_json: {}
  });
  insertBrowserUseLane({
    id: "lane_api_cdp_profile_sidecar_ok",
    runId: "run_api_cdp_profile_sidecar_ok",
    cdpPort: 9471,
    profile: "/tmp/profile-cdp-profile-sidecar-ok",
    session: "node-cdp-profile-sidecar-ok",
    updatedAt: "2026-06-11T00:45:00.000Z"
  });

  try {
    const response = await postJson("/api/bridge/node-check", {
      cdpUrl: "http://localhost:9471/",
      profile: "/tmp/profile-cdp-profile-sidecar-ok",
      targetUrl: "http://127.0.0.1:5173/#lanes"
    });
    const body = JSON.parse(response.body) as {
      status: string;
      createdAt: string;
      recordingPath: string;
      geminiQaPath: string;
      metadata: {
        session: string;
        recordingQa: { status: string; reason: string | null; recorderStatus: string };
        geminiVideoQa: { status: string; exactBlocker: string | null };
      };
    };
    const lane = db.querySql<{ health: string; updated_at: string; browser_use_session: string; browser_use_cdp_url: string; browser_use_profile: string }>(
      "SELECT health, updated_at, browser_use_session, browser_use_cdp_url, browser_use_profile FROM lanes WHERE id='lane_api_cdp_profile_sidecar_ok'"
    )[0];
    const systemCheck = db.querySql<{ status: string; metadata_json: string }>("SELECT status, metadata_json FROM system_checks ORDER BY created_at DESC LIMIT 1")[0];
    const systemCheckMetadata = JSON.parse(systemCheck.metadata_json) as {
      recordingQa?: { status: string };
      geminiVideoQa?: { status: string };
      metadata?: { recordingQa?: { status: string }; geminiVideoQa?: { status: string } };
    };
    const persistedRecordingQa = systemCheckMetadata.metadata?.recordingQa ?? systemCheckMetadata.recordingQa;
    const persistedGeminiVideoQa = systemCheckMetadata.metadata?.geminiVideoQa ?? systemCheckMetadata.geminiVideoQa;

    assert.equal(response.status, 200);
    assert.equal(body.status, "ok");
    assert.equal(body.metadata.session, "node-cdp-profile-sidecar-ok");
    assert.equal(body.recordingPath.endsWith("/recording.mp4"), true);
    assert.equal(body.geminiQaPath.endsWith("/gemini-video-qa.json"), true);
    assert.equal(body.metadata.recordingQa.status, "present");
    assert.equal(body.metadata.recordingQa.reason, null);
    assert.equal(body.metadata.recordingQa.recorderStatus, "captured");
    assert.equal(body.metadata.geminiVideoQa.status, "present");
    assert.equal(body.metadata.geminiVideoQa.exactBlocker, null);
    assert.equal(lane.health, "good");
    assert.equal(lane.updated_at, body.createdAt);
    assert.equal(lane.browser_use_session, "node-cdp-profile-sidecar-ok");
    assert.equal(lane.browser_use_cdp_url, "http://127.0.0.1:9471");
    assert.equal(lane.browser_use_profile, "/tmp/profile-cdp-profile-sidecar-ok");
    assert.equal(systemCheck.status, "ok");
    assert.equal(persistedRecordingQa?.status, "present");
    assert.equal(persistedGeminiVideoQa?.status, "present");
  } finally {
    restoreBrowserUseCli();
  }
});

test("POST /api/bridge/node-check uses the latest safe Browser Use CDP fallback when lane details are omitted", async () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM system_checks; DELETE FROM bridge_actions;");
  const restoreBrowserUseCli = installBrowserUseSidecarFakeCli("node-direct-safe-fallback");
  insertBrowserUseSystemCheck({
    id: "browser_use_safe_fallback_direct",
    createdAt: "2026-06-12T01:00:00.000Z",
    status: "ok",
    cdpUrl: "http://localhost:9480/",
    profile: null
  });

  try {
    const response = await postJson("/api/bridge/node-check", {
      targetUrl: "http://127.0.0.1:5173/#lanes"
    });
    const body = JSON.parse(response.body) as {
      status: string;
      metadata: { connectionStrategy: { cdpUrl: string; profile: string | null }; recordingQa: { status: string }; geminiVideoQa: { status: string; exactBlocker: string | null } };
    };
    const lanes = db.querySql<{ id: string }>("SELECT id FROM lanes WHERE browser_use_cdp_url='http://127.0.0.1:9480' OR browser_use_profile='/tmp/profile-safe-fallback-direct'");

    assert.equal(response.status, 200);
    assert.equal(body.status, "ok");
    assert.equal(body.metadata.connectionStrategy.cdpUrl, "http://127.0.0.1:9480");
    assert.equal(body.metadata.connectionStrategy.profile, null);
    assert.equal(body.metadata.recordingQa.status, "present");
    assert.equal(body.metadata.geminiVideoQa.status, "present");
    assert.equal(body.metadata.geminiVideoQa.exactBlocker, null);
    assert.deepEqual(lanes, []);
  } finally {
    restoreBrowserUseCli();
  }
});

test("POST /api/bridge/actions/browser_use_local_check/run uses the latest safe Browser Use CDP fallback when lane details are omitted", async () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM system_checks; DELETE FROM bridge_actions;");
  const restoreBrowserUseCli = installBrowserUseSidecarFakeCli("node-action-safe-fallback");
  insertBrowserUseSystemCheck({
    id: "browser_use_safe_fallback_action",
    createdAt: "2026-06-12T01:05:00.000Z",
    status: "ok",
    cdpUrl: "http://127.0.0.1:9481",
    profile: "/tmp/profile-safe-fallback-action"
  });

  try {
    const response = await postJson("/api/bridge/actions/browser_use_local_check/run", {
      targetUrl: "http://127.0.0.1:5173/#lanes"
    });
    const body = JSON.parse(response.body) as {
      status: string;
      systemCheck: { status: string; metadata: { connectionStrategy: { cdpUrl: string; profile: string } } };
      metadata: { connectionStrategy: { cdpUrl: string; profile: string }; laneId?: string };
    };

    assert.equal(response.status, 200);
    assert.equal(body.status, "ok");
    assert.equal(body.systemCheck.status, "ok");
    assert.equal(body.systemCheck.metadata.connectionStrategy.cdpUrl, "http://127.0.0.1:9481");
    assert.equal(body.systemCheck.metadata.connectionStrategy.profile, "/tmp/profile-safe-fallback-action");
    assert.equal(body.metadata.connectionStrategy.cdpUrl, "http://127.0.0.1:9481");
    assert.equal(body.metadata.connectionStrategy.profile, "/tmp/profile-safe-fallback-action");
    assert.equal(body.metadata.laneId, undefined);
  } finally {
    restoreBrowserUseCli();
  }
});

test("POST /api/bridge/node-check keeps explicit CDP details strict instead of using the safe fallback", async () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM system_checks; DELETE FROM bridge_actions;");
  const restoreBrowserUseCli = installBrowserUseSidecarFakeCli("node-explicit-no-fallback");
  insertBrowserUseSystemCheck({
    id: "browser_use_safe_fallback_explicit",
    createdAt: "2026-06-12T01:10:00.000Z",
    status: "ok",
    cdpUrl: "http://127.0.0.1:9482",
    profile: "/tmp/profile-safe-fallback-explicit"
  });

  try {
    const response = await postJson("/api/bridge/node-check", {
      cdpUrl: "http://localhost:9483/",
      profile: "/tmp/profile-explicit-no-fallback",
      targetUrl: "http://127.0.0.1:5173/#lanes"
    });
    const body = JSON.parse(response.body) as { status: string; metadata: { connectionStrategy: { cdpUrl: string; profile: string } } };

    assert.equal(response.status, 200);
    assert.equal(body.status, "ok");
    assert.equal(body.metadata.connectionStrategy.cdpUrl, "http://127.0.0.1:9483");
    assert.equal(body.metadata.connectionStrategy.profile, "/tmp/profile-explicit-no-fallback");
  } finally {
    restoreBrowserUseCli();
  }
});

test("POST /api/bridge/node-check ignores blocked and Gemini-blocked Browser Use CDP history", async () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM system_checks; DELETE FROM bridge_actions;");
  const restoreBrowserUseCli = installBrowserUseFakeCli("node-unsafe-fallback-ignored");
  insertBrowserUseSystemCheck({
    id: "browser_use_blocked_fallback_candidate",
    createdAt: "2026-06-12T01:20:00.000Z",
    status: "blocked",
    cdpUrl: "http://127.0.0.1:9484",
    profile: "/tmp/profile-blocked-fallback"
  });
  insertBrowserUseSystemCheck({
    id: "browser_use_gemini_blocked_fallback_candidate",
    createdAt: "2026-06-12T01:21:00.000Z",
    status: "ok",
    cdpUrl: "http://127.0.0.1:9485",
    profile: "/tmp/profile-gemini-blocked-fallback",
    geminiExactBlocker: "gemini_video_qa_completion_alignment"
  });

  try {
    const response = await postJson("/api/bridge/node-check", {
      targetUrl: "http://127.0.0.1:5173/#lanes"
    });
    const body = JSON.parse(response.body) as {
      status: string;
      metadata: { connectionStrategy: { cdpUrl: string | null; profile: string | null }; recordingQa: { reason: string; recorderStatus: string } };
    };

    assert.equal(response.status, 200);
    assert.equal(body.status, "blocked");
    assert.equal(body.metadata.connectionStrategy.cdpUrl, null);
    assert.equal(body.metadata.connectionStrategy.profile, null);
    assert.equal(body.metadata.recordingQa.reason, "browser_use_recording_requires_cdp_lane");
    assert.equal(body.metadata.recordingQa.recorderStatus, "unavailable");
  } finally {
    restoreBrowserUseCli();
  }
});

test("GET /api/dashboard includes persisted system check results", async () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM system_checks; DELETE FROM bridge_actions; DELETE FROM bridge_executions;");
  db.insert("system_checks", {
    id: "check_dashboard",
    kind: "browser_check",
    status: "ok",
    target_url: "http://127.0.0.1:5173/#sources",
    summary: "Local screen verified",
    artifact_uri: "file:///tmp/screen.png",
    created_at: "2026-06-06T00:00:00.000Z",
    metadata_json: { screenshotPath: "/tmp/screen.png" }
  });
  db.insert("system_checks", {
    id: "check_browser_use_dashboard",
    kind: "browser_check",
    status: "ok",
    target_url: "http://127.0.0.1:5173/#sources",
    summary: "Browser Use CLI completed open/state/screenshot",
    artifact_uri: "file:///tmp/node.png",
    created_at: "2026-06-05T23:59:00.000Z",
    metadata_json: {
      driver: "browser_use_cli",
      targetUrl: "http://127.0.0.1:5173/#sources",
      screenshotPath: "/tmp/node.png",
      statePath: "/tmp/node-state.json",
      logPath: "/tmp/node.log",
      metadata: {
        session: "node-check-test",
        driver: "browser_use_cli",
        connectionStrategy: {
          mode: "cdp_profile_lane",
          session: "node-check-test",
          cdpUrl: "http://127.0.0.1:9444",
          profile: "/tmp/profile"
        },
        cleanup: {
          attempted: false,
          status: "skipped",
          reason: "cdp_profile_lane_is_owned_by_external_browser",
          command: null
        }
      }
    }
  });
  db.insert("system_checks", {
    id: "check_browser_use_blocked_dashboard",
    kind: "browser_check",
    status: "blocked",
    target_url: "http://127.0.0.1:5173/#sources",
    summary: "Browser Use cleanup failed",
    artifact_uri: "file:///tmp/node-blocked.png",
    created_at: "2026-06-06T00:00:03.000Z",
    metadata_json: {
      metadata: {
        driver: "browser_use_cli",
        cleanup: {
          status: "blocked",
          reason: "close_failed"
        }
      }
    }
  });
  db.insert("system_checks", {
    id: "check_local_blocked_dashboard",
    kind: "browser_check",
    status: "blocked",
    target_url: "http://127.0.0.1:5173/#sources",
    summary: "Local screen check artifact missing",
    artifact_uri: null,
    created_at: "2026-06-06T00:00:05.000Z",
    metadata_json: {
      driver: "playwright_cli",
      missingArtifacts: ["screenshotPath"]
    }
  });
  db.insert("system_checks", {
    id: "local_codex_worker_heartbeat",
    kind: "local_codex_worker",
    status: "ok",
    target_url: null,
    summary: "待機中です",
    artifact_uri: null,
    created_at: "2026-06-06T00:00:06.000Z",
    metadata_json: {
      intervalMs: 1000,
      processed: 2,
      usesApiKey: false,
      host: "remote-worker-host",
      pid: 12345,
      codexBin: "codex"
    }
  });
  db.insert("bridge_actions", {
    id: "bridge_dashboard",
    capability_id: "codex_inventory",
    label: "Codex機能を確認",
    status: "ok",
    risk_level: "safe",
    target: null,
    summary: "Inventory checked",
    created_at: "2026-06-06T00:00:01.000Z",
    metadata_json: {}
  });
  db.insert("knowledge_notes", {
    id: "knowledge_dashboard",
    note_type: "operating_snapshot",
    title: "Current state",
    body: "UI stays simple.",
    tags_json: ["state"],
    source_ref: "runs",
    created_at: "2026-06-06T00:00:02.000Z",
    updated_at: "2026-06-06T00:00:02.000Z",
    metadata_json: {}
  });
  db.insert("bridge_executions", {
    id: "bridge_exec_dashboard",
    capability_id: "chrome_authenticated_action",
    approval_id: "approval_dashboard",
    status: "blocked",
    executor_status: "not_connected",
    summary: "Executor is not connected",
    created_at: "2026-06-06T00:00:04.000Z",
    updated_at: "2026-06-06T00:00:04.000Z",
    metadata_json: {}
  });
  db.insert("approvals", {
    id: "approval_dashboard_public_inbox",
    run_id: null,
    title: "Bridge approval: publish via runner with exactBlocker data/artifacts/private.json",
    requested_by: "trusted-bridge",
    status: "pending",
    priority: "high",
    approval_group_id: "bridge_dashboard_public_inbox",
    resource_locks_json: ["bridge:chrome_authenticated_action", "social_publish", "profile:/Users/nichikatanaka/private"],
    created_at: "2026-06-06T00:00:05.000Z",
    decided_at: null,
    decision_note: null
  });
  db.insert("approvals", {
    id: "approval_dashboard_history_only",
    run_id: null,
    title: "Historical approval should stay in DB but not normal inbox",
    requested_by: "trusted-bridge",
    status: "approved",
    priority: "medium",
    approval_group_id: "bridge_dashboard_public_history",
    resource_locks_json: ["social_publish"],
    created_at: "2026-06-06T00:00:06.000Z",
    decided_at: "2026-06-06T00:00:07.000Z",
    decision_note: "history row"
  });
  for (const row of [
    {
      runId: "run_dashboard_old_pending_same_workflow",
      approvalId: "approval_dashboard_old_pending_same_workflow",
      createdAt: "2026-06-06T00:00:03.000Z"
    },
    {
      runId: "run_dashboard_latest_pending_same_workflow",
      approvalId: "approval_dashboard_latest_pending_same_workflow",
      createdAt: "2026-06-06T00:00:08.000Z"
    }
  ]) {
    db.insert("runs", {
      id: row.runId,
      name: "Daily AI registered approval inbox regression",
      status: "waiting_approval",
      objective: "Daily AI registered workflow approval inbox regression",
      created_at: row.createdAt,
      updated_at: row.createdAt,
      metadata_json: {
        registeredWorkflowId: "daily-ai-research-publish-run"
      }
    });
    db.insert("approvals", {
      id: row.approvalId,
      run_id: row.runId,
      title: "Daily AI publish approval",
      requested_by: "worker",
      status: "pending",
      priority: "high",
      approval_group_id: row.approvalId,
      resource_locks_json: ["social_publish"],
      created_at: row.createdAt,
      decided_at: null,
      decision_note: null
    });
  }
  for (let index = 0; index < 220; index += 1) {
    const createdAt = `2026-06-06T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`;
    db.insert("runs", {
      id: `run_dashboard_duplicate_overflow_${index}`,
      name: "Duplicate workflow approval overflow regression",
      status: "waiting_approval",
      objective: "Duplicate workflow approval overflow regression",
      created_at: createdAt,
      updated_at: createdAt,
      metadata_json: {
        registeredWorkflowId: "approval-inbox-duplicate-overflow"
      }
    });
    db.insert("approvals", {
      id: `approval_dashboard_duplicate_overflow_${index}`,
      run_id: `run_dashboard_duplicate_overflow_${index}`,
      title: `Duplicate overflow approval ${index}`,
      requested_by: "worker",
      status: "pending",
      priority: "low",
      approval_group_id: `bridge_dashboard_duplicate_overflow_${index}`,
      resource_locks_json: ["social_publish"],
      created_at: createdAt,
      decided_at: null,
      decision_note: null
    });
  }
  for (let index = 0; index < 20; index += 1) {
    db.insert("approvals", {
      id: `approval_dashboard_overflow_${index}`,
      run_id: null,
      title: `Overflow approval ${index}`,
      requested_by: "trusted-bridge",
      status: "pending",
      priority: "low",
      approval_group_id: `bridge_dashboard_overflow_${index}`,
      resource_locks_json: ["social_publish"],
      created_at: `2026-06-05T23:59:${String(index).padStart(2, "0")}.000Z`,
      decided_at: null,
      decision_note: null
    });
  }

  const response = await getJson("/api/dashboard");
  const body = JSON.parse(response.body) as {
    systemChecks: Array<{ id: string; status: string; summary: string; metadata_json: string }>;
    localWorker: { status: string; label: string; processed: number; usesApiKey: boolean };
    bridgeActionCatalog: Array<{ id: string }>;
    bridgeActions: Array<{ id: string; status: string }>;
    bridgeExecutions: Array<{ id: string; status: string }>;
    knowledgeNotes: Array<{ id: string; title: string }>;
    registeredWorkflows: Array<{ id: string; name: string; status: string; schedule_label: string; boundary_label: string; needs_check: boolean; check_kind: string; check_label: string; trust_kind: string; trust_label: string; freshness_kind: string; freshness_label: string; safety_kind: string; safety_label: string; readiness?: string; runner_status?: string; runner_kind?: string; last_started_at?: string; latestRunAt?: string; evidenceUpdatedAt?: string; start_command_json?: string; provenance_json?: string; scheduleControl?: unknown; source_refs_json?: string; source_refs?: unknown; provenance?: unknown; project_root?: string; exactBlocker?: string; artifact?: unknown; proof?: unknown; proofName?: string }>;
    approvalInbox: Array<{
      id: string;
      run_id: string | null;
      task_label: string;
      status: string;
      action_kind: string;
      action_label: string;
      boundary_label: string;
      execution_label: string;
      decision_enabled: boolean;
      title?: string;
      objective?: string;
      resource_locks_json?: string;
      metadata_json?: string;
      provenance_json?: string;
      exactBlocker?: string;
      path?: string;
      runner?: string;
      artifact?: unknown;
      proof?: unknown;
    }>;
    externalPreflightChecklist: Array<{ key: string; label: string; state: string; title?: string; objective?: string; metadata_json?: string; path?: string }>;
    nextActions: Array<{ id: string; title: string }>;
    resumeContract: { readFirst: Array<{ label: string }>; projects: Array<{ cwd: string }>; resumeRule: string };
    codexParityLedger: { items: Array<{ capability: string; status: string; latestProof: string }> };
    codexAutomationMigrationLedger: {
      summary: {
        total: number;
        registered: number;
        unregistered: number;
        inactive: number;
        manual_helper: number;
        registeredWorkflowTotal: number;
        migrated: number;
        scheduledConfirmed: number;
        actualConfirmed: number;
        proofConfirmed: number;
        blocked: number;
      };
      items: Array<{ registeredWorkflowId: string | null; automationOsMigrated: boolean; inventorySource: string }>;
    };
  };

  assert.equal(response.status, 200);
  const localCheck = body.systemChecks.find((check) => check.id === "check_dashboard");
  assert.ok(localCheck);
  assert.equal(localCheck.status, "ok");
  assert.equal(localCheck.summary, "Local screen verified");
  assert.equal(body.localWorker.status, "ok");
  assert.equal(body.localWorker.label, "待機中");
  assert.equal(body.localWorker.processed, 2);
  assert.equal(body.localWorker.usesApiKey, false);
  assert.equal(JSON.stringify(body.localWorker).includes("12345"), false);
  assert.equal(JSON.stringify(body.localWorker).includes("codexBin"), false);
  assert.equal(JSON.stringify(body.localWorker).includes("remote-worker-host"), false);
  assert.equal(JSON.stringify(body.systemChecks).includes("remote-worker-host"), false);
  assert.equal(JSON.stringify(body.systemChecks).includes("codexBin"), false);
  const browserUseCheck = body.systemChecks.find((check) => check.id === "check_browser_use_dashboard");
  assert.ok(browserUseCheck);
  const browserUseMetadata = JSON.parse(browserUseCheck.metadata_json) as {
    driver: string;
    browser_use_result: {
      driver: string;
      evidenceCount: number;
      connectionMode: string;
      cleanupStatus: string;
    };
  };
  assert.equal(browserUseMetadata.driver, "browser_use_cli");
  assert.deepEqual(browserUseMetadata.browser_use_result, {
    driver: "browser_use_cli",
    evidenceCount: 3,
    connectionMode: "cdp_profile_lane",
    cleanupStatus: "skipped"
  });
  assert.doesNotMatch(browserUseCheck.metadata_json, /node-check-test|127\.0\.0\.1:9444|\/tmp\/profile|screenshotPath|statePath|logPath/);
  assert.ok(body.bridgeActionCatalog.some((action) => action.id === "local_browser_check"));
  assert.equal(body.bridgeActions[0].id, "bridge_dashboard");
  assert.ok(Array.isArray(body.bridgeExecutions));
  const browserUseLedger = body.codexParityLedger.items.find((item) => item.capability === "Browser Use local screen checks");
  const localScreenLedger = body.codexParityLedger.items.find((item) => item.capability === "Local screen checks");
  const protectedLedger = body.codexParityLedger.items.find((item) => item.capability === "Protected external actions");
  assert.ok(browserUseLedger);
  assert.equal(browserUseLedger.status, "blocked");
  assert.match(browserUseLedger.latestProof, /id=check_browser_use_blocked_dashboard/);
  assert.ok(localScreenLedger);
  assert.equal(localScreenLedger.status, "blocked");
  assert.match(localScreenLedger.latestProof, /id=check_local_blocked_dashboard/);
  assert.ok(protectedLedger);
  assert.equal(protectedLedger.status, "blocked_by_executor");
  assert.match(protectedLedger.latestProof, /executor_status=not_connected/);
  assert.ok(body.nextActions.length > 0);
  assert.ok(body.knowledgeNotes.some((note) => note.id === "knowledge_dashboard"));
  assert.ok(body.codexAutomationMigrationLedger.summary);
  assert.equal(typeof body.codexAutomationMigrationLedger.summary.registeredWorkflowTotal, "number");
  assert.equal(typeof body.codexAutomationMigrationLedger.summary.migrated, "number");
  assert.equal(typeof body.codexAutomationMigrationLedger.summary.scheduledConfirmed, "number");
  assert.equal(typeof body.codexAutomationMigrationLedger.summary.actualConfirmed, "number");
  assert.equal(typeof body.codexAutomationMigrationLedger.summary.proofConfirmed, "number");
  assert.equal(typeof body.codexAutomationMigrationLedger.summary.blocked, "number");
  assert.ok(body.codexAutomationMigrationLedger.items.some((item) => item.registeredWorkflowId && item.automationOsMigrated));
  assert.ok(body.approvalInbox.length > 0);
  assert.equal(body.approvalInbox.length, 12);
  assert.ok(body.approvalInbox.every((approval) => approval.status === "pending"));
  assert.equal(body.approvalInbox.some((approval) => approval.id === "approval_dashboard_history_only"), false);
  assert.equal(db.querySql<{ count: number }>("SELECT count(*) AS count FROM approvals WHERE id='approval_dashboard_history_only'")[0].count, 1);
  assert.equal(body.approvalInbox.some((approval) => approval.id === "approval_dashboard_old_pending_same_workflow"), false);
  assert.equal(body.approvalInbox.some((approval) => approval.id === "approval_dashboard_latest_pending_same_workflow"), true);
  assert.equal(body.approvalInbox.some((approval) => approval.id === "approval_dashboard_public_inbox"), true);
  assert.equal(
    db.querySql<{ count: number }>(
      "SELECT count(*) AS count FROM approvals WHERE id IN ('approval_dashboard_old_pending_same_workflow', 'approval_dashboard_latest_pending_same_workflow')"
    )[0].count,
    2
  );
  assert.ok(body.approvalInbox.every((approval) => Object.keys(approval).sort().join(",") === "action_kind,action_label,boundary_label,decision_enabled,execution_label,id,run_id,status,task_label"));
  assert.ok(body.approvalInbox.every((approval) => typeof approval.decision_enabled === "boolean"));
  assert.ok(body.approvalInbox.every((approval) => approval.title === undefined));
  assert.ok(body.approvalInbox.every((approval) => approval.objective === undefined));
  assert.ok(body.approvalInbox.every((approval) => approval.resource_locks_json === undefined));
  assert.ok(body.approvalInbox.every((approval) => approval.metadata_json === undefined));
  assert.ok(body.approvalInbox.every((approval) => approval.provenance_json === undefined));
  assert.ok(body.approvalInbox.every((approval) => approval.exactBlocker === undefined));
  assert.ok(body.approvalInbox.every((approval) => approval.path === undefined));
  assert.ok(body.approvalInbox.every((approval) => approval.runner === undefined));
  assert.ok(body.approvalInbox.every((approval) => approval.artifact === undefined));
  assert.ok(body.approvalInbox.every((approval) => approval.proof === undefined));
  assert.doesNotMatch(JSON.stringify(body.approvalInbox), /proof|artifact|runner|provenance|exactBlocker|resource_locks|metadata_json|title|objective|\/Users|data\/artifacts|CDP|profile|sidecar|Gemini|json|path/i);
  assert.ok(body.externalPreflightChecklist.length >= 3);
  assert.ok(body.externalPreflightChecklist.every((item) => Object.keys(item).sort().join(",") === "key,label,state"));
  assert.ok(body.externalPreflightChecklist.every((item) => typeof item.key === "string" && typeof item.label === "string" && typeof item.state === "string"));
  assert.doesNotMatch(JSON.stringify(body.externalPreflightChecklist), /proof|artifact|runner|provenance|exactBlocker|resource_locks|metadata_json|title|objective|\/Users|data\/artifacts|CDP|profile|sidecar|Gemini|json|path/i);
  assert.equal(body.registeredWorkflows.length, 6);
  assert.ok(body.registeredWorkflows.some((workflow) => workflow.id === "daily-ai-research-publish-run"));
  assert.equal(body.registeredWorkflows.find((workflow) => workflow.id === "daily-ai-research-publish-run")?.boundary_label, "投稿可・課金停止");
  assert.equal(body.registeredWorkflows.find((workflow) => workflow.id === "nisenprints-daily-product-canva-printify-etsy-pinterest")?.boundary_label, "投稿可・課金停止");
  assert.equal(body.registeredWorkflows.find((workflow) => workflow.id === "job-application-manager")?.boundary_label, "応募可・課金停止");
  assert.equal(body.registeredWorkflows.find((workflow) => workflow.id === "x-authenticated-browser-lane")?.boundary_label, "人間入力を証跡化");
  assert.equal(body.registeredWorkflows.find((workflow) => workflow.id === "prompt-transfer-ukiyoe")?.boundary_label, "保存可・課金停止");
  assert.deepEqual(
    body.registeredWorkflows.map((workflow) => workflow.name).sort(),
    ["Daily AI", "NisenPrints", "SNS", "X", "応募", "転記"].sort()
  );
  assert.ok(body.registeredWorkflows.every((workflow) => typeof workflow.schedule_label === "string"));
  assert.ok(body.registeredWorkflows.every((workflow) => typeof workflow.boundary_label === "string"));
  assert.ok(body.registeredWorkflows.every((workflow) => typeof workflow.needs_check === "boolean"));
  assert.ok(body.registeredWorkflows.every((workflow) => ["none", "billing", "boundary", "proof", "runner", "schedule"].includes(workflow.check_kind)));
  assert.ok(body.registeredWorkflows.every((workflow) => ["OK", "承認", "境界", "記録", "接続", "予定"].includes(workflow.check_label)));
  assert.ok(body.registeredWorkflows.every((workflow) => ["high", "medium", "low", "unknown"].includes(workflow.trust_kind)));
  assert.ok(body.registeredWorkflows.every((workflow) => ["信頼", "境界", "要確認", "未確認"].includes(workflow.trust_label)));
  assert.ok(body.registeredWorkflows.every((workflow) => ["fresh", "recent", "stale", "unknown"].includes(workflow.freshness_kind)));
  assert.ok(body.registeredWorkflows.every((workflow) => ["新", "最近", "古い", "未"].includes(workflow.freshness_label)));
  assert.ok(body.registeredWorkflows.every((workflow) => ["billing_only", "review"].includes(workflow.safety_kind)));
  assert.ok(body.registeredWorkflows.every((workflow) => ["課金停止", "確認"].includes(workflow.safety_label)));
  assert.ok(body.registeredWorkflows.every((workflow) => Object.keys(workflow).sort().join(",") === publicRegisteredWorkflowKeys.join(",")));
  assert.ok(body.registeredWorkflows.every((workflow) => workflow.readiness === undefined));
  assert.ok(body.registeredWorkflows.every((workflow) => workflow.runner_status === undefined));
  assert.ok(body.registeredWorkflows.every((workflow) => workflow.runner_kind === undefined));
  assert.ok(body.registeredWorkflows.every((workflow) => workflow.last_started_at === undefined));
  assert.ok(body.registeredWorkflows.every((workflow) => workflow.latestRunAt === undefined));
  assert.ok(body.registeredWorkflows.every((workflow) => workflow.evidenceUpdatedAt === undefined));
  assert.ok(body.registeredWorkflows.every((workflow) => workflow.start_command_json === undefined));
  assert.ok(body.registeredWorkflows.every((workflow) => workflow.provenance_json === undefined));
  assert.ok(body.registeredWorkflows.every((workflow) => workflow.provenance === undefined));
  assert.ok(body.registeredWorkflows.every((workflow) => workflow.scheduleControl === undefined));
  assert.ok(body.registeredWorkflows.every((workflow) => workflow.source_refs_json === undefined));
  assert.ok(body.registeredWorkflows.every((workflow) => workflow.source_refs === undefined));
  assert.ok(body.registeredWorkflows.every((workflow) => workflow.project_root === undefined));
  assert.ok(body.registeredWorkflows.every((workflow) => workflow.exactBlocker === undefined));
  assert.ok(body.registeredWorkflows.every((workflow) => workflow.artifact === undefined));
  assert.ok(body.registeredWorkflows.every((workflow) => workflow.proof === undefined));
  assert.ok(body.registeredWorkflows.every((workflow) => workflow.proofName === undefined));
  assert.ok(body.resumeContract.readFirst.some((entry) => entry.label === "Project Handoff Index"));
  assert.ok(body.resumeContract.projects.some((project) => project.cwd === "/Users/nichikatanaka/Documents/Codex/automation-os"));
  assert.match(body.resumeContract.resumeRule, /Before asking the user to restate context/);
  assert.match(body.resumeContract.resumeRule, /Natural resume questions/);
  assert.match(body.resumeContract.resumeRule, /AutomationOSは何をやっていた/);
  assert.match(body.resumeContract.resumeRule, /<project>は何をやっていた/);
});

test("registered workflow allowlist limits public API and dashboard lists without deleting fixed definitions", async () => {
  db.initDb();
  db.resetDemoData();
  const previous = process.env.AUTOMATION_OS_REGISTERED_WORKFLOW_ALLOWLIST;
  process.env.AUTOMATION_OS_REGISTERED_WORKFLOW_ALLOWLIST = [
    "daily-ai-research-publish-run",
    "nisenprints-daily-product-canva-printify-etsy-pinterest",
    "job-application-manager"
  ].join(",");
  try {
    const apiResponse = await getJson("/api/registered-workflows");
    const apiBody = JSON.parse(apiResponse.body) as { workflows: Array<{ id: string }> };
    const expectedIds = [
      "daily-ai-research-publish-run",
      "nisenprints-daily-product-canva-printify-etsy-pinterest",
      "job-application-manager"
    ].sort();
    assert.deepEqual(apiBody.workflows.map((workflow) => workflow.id).sort(), expectedIds);

    const dashboardResponse = await getJson("/api/dashboard");
    const dashboardBody = JSON.parse(dashboardResponse.body) as { registeredWorkflows: Array<{ id: string }> };
    assert.deepEqual(dashboardBody.registeredWorkflows.map((workflow) => workflow.id).sort(), expectedIds);

    const storedCount = db.querySql<{ count: number }>("SELECT count(*) AS count FROM registered_workflows;")[0].count;
    assert.equal(storedCount, 6);

    const pauseResponse = await postJson("/api/registered-workflows/prompt-transfer-ukiyoe/pause", {});
    const pauseBody = JSON.parse(pauseResponse.body) as { workflow: { id: string } | null };
    assert.equal(pauseResponse.status, 200);
    assert.equal(pauseBody.workflow?.id, "prompt-transfer-ukiyoe");
  } finally {
    if (previous === undefined) delete process.env.AUTOMATION_OS_REGISTERED_WORKFLOW_ALLOWLIST;
    else process.env.AUTOMATION_OS_REGISTERED_WORKFLOW_ALLOWLIST = previous;
  }
});

test("GET /api/dashboard only marks worker heartbeat stale for same host", async () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM runs; DELETE FROM approvals; DELETE FROM system_checks; DELETE FROM bridge_executions; DELETE FROM bridge_actions; DELETE FROM knowledge_notes;");
  db.insert("system_checks", {
    id: "local_codex_worker_heartbeat",
    kind: "local_codex_worker",
    status: "ok",
    target_url: null,
    summary: "Remote worker running",
    artifact_uri: null,
    created_at: "2026-06-06T00:00:01.000Z",
    metadata_json: {
      lifecycle: "running",
      host: "remote-worker-host",
      pid: 999999,
      processed: 3
    }
  });
  let response = await getJson("/api/dashboard");
  let body = JSON.parse(response.body) as { localWorker: { status: string; processed: number } };
  assert.equal(body.localWorker.status, "ok");
  assert.equal(body.localWorker.processed, 3);

  db.execSql("DELETE FROM system_checks;");
  db.insert("system_checks", {
    id: "local_codex_worker_heartbeat",
    kind: "local_codex_worker",
    status: "ok",
    target_url: null,
    summary: "Legacy worker running",
    artifact_uri: null,
    created_at: "2026-06-06T00:00:02.000Z",
    metadata_json: {
      lifecycle: "running",
      pid: 999999,
      processed: 4
    }
  });
  response = await getJson("/api/dashboard");
  body = JSON.parse(response.body) as { localWorker: { status: string; processed: number } };
  assert.equal(body.localWorker.status, "ok");
  assert.equal(body.localWorker.processed, 4);

  db.execSql("DELETE FROM system_checks;");
  db.insert("system_checks", {
    id: "local_codex_worker_heartbeat",
    kind: "local_codex_worker",
    status: "ok",
    target_url: null,
    summary: "Same host worker running",
    artifact_uri: null,
    created_at: "2026-06-06T00:00:03.000Z",
    metadata_json: {
      lifecycle: "running",
      host: hostname(),
      pid: 999999,
      processed: 5
    }
  });
  response = await getJson("/api/dashboard");
  body = JSON.parse(response.body) as { localWorker: { status: string; processed: number } };
  assert.equal(body.localWorker.status, "idle");
  assert.equal(body.localWorker.processed, 5);
});

test("registered workflow schedule pause survives refresh without exposing internals on dashboard", async () => {
  db.initDb();
  db.resetDemoData();

  const pauseResponse = await postJson("/api/registered-workflows/daily-ai-research-publish-run/pause", {});
  const pauseBody = JSON.parse(pauseResponse.body) as { workflow: Record<string, unknown> };
  assert.equal(pauseResponse.status, 200);
  assertPublicRegisteredWorkflowRow(pauseBody.workflow);
  assert.equal(pauseBody.workflow.id, "daily-ai-research-publish-run");
  assert.equal(pauseBody.workflow.status, "paused");
  assert.equal(pauseBody.workflow.trust_kind, "unknown");
  assert.equal(pauseBody.workflow.freshness_kind, "unknown");
  assert.equal(pauseBody.workflow.provenance_json, undefined);
  assert.equal(pauseBody.workflow.scheduleControl, undefined);

  const firstDashboard = JSON.parse((await getJson("/api/dashboard")).body) as {
    registeredWorkflows: Array<Record<string, unknown>>;
  };
  const paused = firstDashboard.registeredWorkflows.find((workflow) => workflow.id === "daily-ai-research-publish-run");
  assert.ok(paused);
  assertPublicRegisteredWorkflowRow(paused);
  assert.equal(paused?.status, "paused");
  assert.equal(paused?.trust_kind, pauseBody.workflow.trust_kind);
  assert.equal(paused?.freshness_kind, pauseBody.workflow.freshness_kind);
  assert.equal(paused?.provenance_json, undefined);
  assert.equal(paused?.scheduleControl, undefined);
  assert.equal(paused?.project_root, undefined);

  const refreshResponse = await postJson("/api/registered-workflows/refresh", {});
  const refreshBody = JSON.parse(refreshResponse.body) as { workflows: Array<Record<string, unknown>> };
  assert.equal(refreshResponse.status, 200);
  assertPublicRegisteredWorkflowRows(refreshBody.workflows);
  assert.equal(refreshBody.workflows.find((workflow) => workflow.id === "daily-ai-research-publish-run")?.status, "paused");
  const afterRefreshDashboard = JSON.parse((await getJson("/api/dashboard")).body) as {
    registeredWorkflows: Array<Record<string, unknown>>;
  };
  assert.equal(afterRefreshDashboard.registeredWorkflows.find((workflow) => workflow.id === "daily-ai-research-publish-run")?.status, "paused");

  const resumeResponse = await postJson("/api/registered-workflows/daily-ai-research-publish-run/resume", {});
  const resumeBody = JSON.parse(resumeResponse.body) as { workflow: Record<string, unknown> };
  assert.equal(resumeResponse.status, 200);
  assertPublicRegisteredWorkflowRow(resumeBody.workflow);
  assert.equal(resumeBody.workflow.status, "active");
  assert.equal(resumeBody.workflow.trust_kind, "unknown");
  assert.equal(resumeBody.workflow.freshness_kind, "unknown");
  assert.equal(resumeBody.workflow.provenance_json, undefined);
  assert.equal(resumeBody.workflow.scheduleControl, undefined);
});

test("dashboard registered workflow needs_check reflects actionable migration ledger blockers", async () => {
  db.initDb();
  db.resetDemoData();
  const now = db.nowIso();
  db.insert("runs", {
    id: "run_dashboard_registered_ledger_blocked",
    name: "Daily AI ledger blocked run",
    status: "blocked",
    objective: "Daily AI Research + Publish Run",
    created_at: now,
    updated_at: now,
    metadata_json: {
      registered_workflow_id: "daily-ai-research-publish-run",
      blocker: "browser_use_registered_runner_missing",
      proof_gate: {
        ok: false,
        missing: ["daily_ai_publish"],
        present: []
      }
    }
  });

  const response = await getJson("/api/dashboard");
  const body = JSON.parse(response.body) as {
    registeredWorkflows: Array<{ id: string; needs_check: boolean; check_kind: string; check_label: string; trust_kind: string; trust_label: string; freshness_kind: string; freshness_label: string; safety_kind: string; safety_label: string; provenance_json?: string; remainingBlocker?: string; latestRunAt?: string; evidenceUpdatedAt?: string; proof?: unknown; artifact?: unknown; exactBlocker?: string; project_root?: string }>;
    codexAutomationMigrationLedger: {
      items: Array<{ registeredWorkflowId: string | null; remainingBlocker: string | null; latestRunStatus: string | null }>;
    };
  };
  const workflow = body.registeredWorkflows.find((item) => item.id === "daily-ai-research-publish-run");
  const ledgerItem = body.codexAutomationMigrationLedger.items.find((item) => item.registeredWorkflowId === "daily-ai-research-publish-run");

  assert.equal(response.status, 200);
  assert.ok(workflow);
  assert.equal(workflow.needs_check, true);
  assert.equal(workflow.check_kind, "runner");
  assert.equal(workflow.check_label, "接続");
  assert.equal(workflow.trust_kind, "low");
  assert.equal(workflow.trust_label, "要確認");
  assert.deepEqual(Object.keys(workflow).sort(), publicRegisteredWorkflowKeys);
  assert.equal(workflow.provenance_json, undefined);
  assert.equal(workflow.remainingBlocker, undefined);
  assert.equal(workflow.latestRunAt, undefined);
  assert.equal(workflow.evidenceUpdatedAt, undefined);
  assert.equal(workflow.proof, undefined);
  assert.equal(workflow.artifact, undefined);
  assert.equal(workflow.exactBlocker, undefined);
  assert.equal(workflow.project_root, undefined);
  assert.ok(ledgerItem);
  assert.equal(ledgerItem.remainingBlocker, "browser_use_registered_runner_missing");
  assert.equal(ledgerItem.latestRunStatus, "blocked");
});

test("dashboard registered workflows expose public trust and freshness labels without evidence timestamps", async () => {
  db.initDb();
  db.resetDemoData();
  const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();
  const fresh = isoAgo(60 * 60 * 1000);
  const recent = isoAgo(3 * 24 * 60 * 60 * 1000);
  const stale = isoAgo(8 * 24 * 60 * 60 * 1000);
  const workflowIds = ["trust-high-fresh", "trust-medium-recent", "trust-low-stale", "trust-unknown-no-run"];
  for (const id of workflowIds) {
    db.insert("registered_workflows", {
      id,
      name: id,
      status: "active",
      runner_status: "connected",
      runner_kind: "daily_ai_registered",
      project_root: tempRoot,
      start_command_json: { command: id, source: "test" },
      schedule_json: { kind: "cron", label: "毎日 09:00", rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0" },
      source_refs_json: [],
      provenance_json: {},
      created_at: stale,
      updated_at: fresh
    });
  }
  db.insert("runs", {
    id: "run_trust_high_fresh",
    name: "trust-high-fresh",
    status: "complete",
    objective: "trust-high-fresh",
    created_at: fresh,
    updated_at: fresh,
    metadata_json: {
      registered_workflow_id: "trust-high-fresh",
      proof_gate: { ok: true, missing: [], present: ["daily_ai_publish"] }
    }
  });
  db.insert("proofs", {
    id: "proof_trust_high_fresh",
    run_id: "run_trust_high_fresh",
    step_id: null,
    proof_type: "daily_ai_publish",
    label: "Daily AI publish",
    uri: "file:///tmp/trust-high-fresh.json",
    size_bytes: 2,
    created_at: fresh,
    metadata_json: {}
  });
  db.insert("runs", {
    id: "run_trust_medium_recent",
    name: "trust-medium-recent",
    status: "waiting_approval",
    objective: "trust-medium-recent",
    created_at: recent,
    updated_at: recent,
    metadata_json: { registered_workflow_id: "trust-medium-recent" }
  });
  db.insert("runs", {
    id: "run_trust_low_stale",
    name: "trust-low-stale",
    status: "blocked",
    objective: "trust-low-stale",
    created_at: stale,
    updated_at: stale,
    metadata_json: {
      registered_workflow_id: "trust-low-stale",
      blocker: "browser_use_registered_runner_missing"
    }
  });

  const response = await getJson("/api/dashboard");
  const body = JSON.parse(response.body) as {
    registeredWorkflows: Array<{
      id: string;
      trust_kind: string;
      trust_label: string;
      freshness_kind: string;
      freshness_label: string;
      latestRunAt?: string;
      evidenceUpdatedAt?: string;
    }>;
  };
  const byId = new Map(body.registeredWorkflows.map((workflow) => [workflow.id, workflow]));

  assert.equal(response.status, 200);
  assert.deepEqual(
    {
      high: byId.get("trust-high-fresh"),
      medium: byId.get("trust-medium-recent"),
      low: byId.get("trust-low-stale"),
      unknown: byId.get("trust-unknown-no-run")
    },
    {
      high: {
        id: "trust-high-fresh",
        name: "定期",
        status: "active",
        schedule_label: "毎日 09:00",
        boundary_label: "投稿可・課金停止",
        needs_check: false,
        check_kind: "none",
        check_label: "OK",
        trust_kind: "high",
        trust_label: "信頼",
        freshness_kind: "fresh",
        freshness_label: "新",
        safety_kind: "review",
        safety_label: "確認",
        last_action_label: "前回の実行",
        last_run_id: "run_trust_high_fresh",
        last_result_label: "完了記録あり",
        next_action_label: "履歴で確認",
        next_action_view: "Runs"
      },
      medium: {
        id: "trust-medium-recent",
        name: "定期",
        status: "active",
        schedule_label: "毎日 09:00",
        boundary_label: "投稿可・課金停止",
        needs_check: false,
        check_kind: "none",
        check_label: "OK",
        trust_kind: "unknown",
        trust_label: "未確認",
        freshness_kind: "recent",
        freshness_label: "最近",
        safety_kind: "review",
        safety_label: "確認",
        last_action_label: "承認待ち",
        last_run_id: "run_trust_medium_recent",
        last_result_label: "確認が必要",
        next_action_label: "承認画面で確認",
        next_action_view: "Approvals"
      },
      low: {
        id: "trust-low-stale",
        name: "定期",
        status: "active",
        schedule_label: "毎日 09:00",
        boundary_label: "投稿可・課金停止",
        needs_check: true,
        check_kind: "runner",
        check_label: "接続",
        trust_kind: "low",
        trust_label: "要確認",
        freshness_kind: "stale",
        freshness_label: "古い",
        safety_kind: "review",
        safety_label: "確認",
        last_action_label: "前回の実行",
        last_run_id: "run_trust_low_stale",
        last_result_label: "確認が必要",
        next_action_label: "履歴で理由を見る",
        next_action_view: "Runs"
      },
      unknown: {
        id: "trust-unknown-no-run",
        name: "定期",
        status: "active",
        schedule_label: "毎日 09:00",
        boundary_label: "投稿可・課金停止",
        needs_check: false,
        check_kind: "none",
        check_label: "OK",
        trust_kind: "unknown",
        trust_label: "未確認",
        freshness_kind: "unknown",
        freshness_label: "未",
        safety_kind: "review",
        safety_label: "確認",
        last_action_label: "まだ実行なし",
        last_run_id: null,
        last_result_label: "待機中",
        next_action_label: "再生で一回実行",
        next_action_view: "Schedule"
      }
    }
  );
  for (const id of workflowIds) {
    assert.equal(byId.get(id)?.latestRunAt, undefined);
    assert.equal(byId.get(id)?.evidenceUpdatedAt, undefined);
  }
});

test("registered workflow schedule PATCH stores override without exposing internals on dashboard", async () => {
  db.initDb();
  db.resetDemoData();
  assert.equal((await postJson("/api/registered-workflows/refresh", {})).status, 200);
  const now = db.nowIso();
  db.insert("runs", {
    id: "run_schedule_public_ledger_fresh",
    name: "Daily AI schedule public ledger fresh",
    status: "complete",
    objective: "Daily AI Research + Publish Run",
    created_at: now,
    updated_at: now,
    metadata_json: {
      registered_workflow_id: "daily-ai-research-publish-run",
      proof_gate: { ok: true, missing: [], present: ["daily_ai_publish"] }
    }
  });
  db.insert("proofs", {
    id: "proof_schedule_public_ledger_fresh",
    run_id: "run_schedule_public_ledger_fresh",
    step_id: null,
    proof_type: "daily_ai_publish",
    label: "Daily AI publish",
    uri: "file:///tmp/schedule-public-ledger-fresh.json",
    size_bytes: 2,
    created_at: now,
    metadata_json: {}
  });

  const before = db.querySql<{ schedule_json: string }>("SELECT schedule_json FROM registered_workflows WHERE id='daily-ai-research-publish-run'")[0];
  const updateResponse = await patchJson("/api/registered-workflows/daily-ai-research-publish-run/schedule", {
    frequency: "weekly",
    time: "07:15",
    days: ["TU"]
  });
  const updateBody = JSON.parse(updateResponse.body) as {
    workflow: Record<string, unknown>;
  };
  assert.equal(updateResponse.status, 200);
  assertPublicRegisteredWorkflowRow(updateBody.workflow);
  assert.deepEqual(Object.keys(updateBody.workflow).sort(), publicRegisteredWorkflowKeys);
  assert.equal(updateBody.workflow.check_kind, "none");
  assert.equal(updateBody.workflow.check_label, "OK");
  assert.equal(updateBody.workflow.trust_kind, "high");
  assert.equal(updateBody.workflow.freshness_kind, "fresh");
  assert.equal(updateBody.workflow.schedule_label, "毎週 07:15 火");
  assert.equal(updateBody.workflow.scheduleOverride, undefined);
  assert.equal(updateBody.workflow.provenance_json, undefined);
  assert.equal(updateBody.workflow.schedule_json, undefined);
  assert.equal(updateBody.workflow.scheduleControl, undefined);
  assert.equal(updateBody.workflow.project_root, undefined);

  const stored = db.querySql<{ schedule_json: string; provenance_json: string }>("SELECT schedule_json, provenance_json FROM registered_workflows WHERE id='daily-ai-research-publish-run'")[0];
  const provenance = JSON.parse(stored.provenance_json) as { scheduleControl?: { scheduleOverride?: { frequency?: string; time?: string; days?: string[] } } };
  assert.equal(stored.schedule_json, before.schedule_json);
  assert.equal(provenance.scheduleControl?.scheduleOverride?.frequency, "weekly");
  assert.equal(provenance.scheduleControl?.scheduleOverride?.time, "07:15");
  assert.deepEqual(provenance.scheduleControl?.scheduleOverride?.days, ["TU"]);

  const refreshResponse = await postJson("/api/registered-workflows/refresh", {});
  assert.equal(refreshResponse.status, 200);
  const dashboard = JSON.parse((await getJson("/api/dashboard")).body) as {
    registeredWorkflows: Array<Record<string, unknown>>;
  };
  const workflow = dashboard.registeredWorkflows.find((item) => item.id === "daily-ai-research-publish-run");
  assert.equal(workflow?.schedule_label, "毎週 07:15 火");
  assert.equal(workflow?.trust_kind, updateBody.workflow.trust_kind);
  assert.equal(workflow?.freshness_kind, updateBody.workflow.freshness_kind);
  assert.equal(workflow?.provenance_json, undefined);
  assert.equal(workflow?.scheduleControl, undefined);
  assert.equal(workflow?.scheduleOverride, undefined);
  assert.equal(workflow?.project_root, undefined);

  const invalid = await patchJson("/api/registered-workflows/daily-ai-research-publish-run/schedule", {
    frequency: "monthly",
    time: "07:15"
  });
  assert.equal(invalid.status, 400);
});

test("GET /api/dashboard finishes resume contract artifact scan for deep fanout without following symlinked artifact dirs", async () => {
  db.initDb();
  db.resetDemoData();
  const automationDir = join(automationRoot, "dashboard-deep-fanout-automation");
  const artifactsDir = join(automationDir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(join(automationDir, "automation.toml"), "name = \"Dashboard deep fanout automation\"\n");
  createDeepFanoutArtifacts(artifactsDir, 0, 3, 14);

  const internalLatest = join(artifactsDir, "01-internal-latest-proof.json");
  writeFileSync(internalLatest, "{}\n");
  const internalDate = new Date("2030-01-01T00:00:00.000Z");
  utimesSync(internalLatest, internalDate, internalDate);

  const externalDir = join(tempRoot, "dashboard-deep-fanout-external");
  mkdirSync(externalDir, { recursive: true });
  const externalLatest = join(externalDir, "outside-newest-proof.json");
  writeFileSync(externalLatest, "{}\n");
  const externalDate = new Date("2030-01-02T00:00:00.000Z");
  utimesSync(externalLatest, externalDate, externalDate);
  symlinkSync(externalDir, join(artifactsDir, "00-linked-external"), "dir");

  const response = await getJson("/api/dashboard");
  const body = JSON.parse(response.body) as {
    resumeContract: { projects: Array<{ cwd: string; latestArtifact: { path: string } | null }> };
  };
  const project = body.resumeContract.projects.find((entry) => entry.cwd === automationDir);

  assert.equal(response.status, 200);
  assert.ok(project);
  assert.equal(project.latestArtifact?.path, internalLatest);
  assert.equal(project.latestArtifact?.path.includes("linked-external"), false);
  assert.equal(project.latestArtifact?.path.includes("outside-newest-proof"), false);
});

test("GET /api/dashboard downgrades legacy receipt-only complete rows even when proof gate was marked ok", async () => {
  db.initDb();
  db.resetDemoData();
  db.insert("runs", {
    id: "run_legacy_receipt_complete",
    name: "Legacy receipt-only row",
    status: "complete",
    objective: "legacy receipt-only row",
    created_at: "2026-06-12T00:00:00.000Z",
    updated_at: "2026-06-12T00:00:00.000Z",
    metadata_json: {
      worker_mode: "receipt_only",
      proof_gate: { ok: true, missing: [], present: ["worker_receipt"] },
      proof_summary: "complete: all required proof types are present"
    }
  });
  db.insert("runs", {
    id: "run_legacy_receipt_complete_stale_summary",
    name: "Legacy receipt-only stale summary row",
    status: "complete",
    objective: "legacy receipt-only stale summary row",
    created_at: "2026-06-12T00:00:01.000Z",
    updated_at: "2026-06-12T00:00:01.000Z",
    metadata_json: {
      worker_mode: "receipt_only",
      proof_gate: { ok: false, missing: ["actual_execution_or_manual_verification"], present: ["worker_receipt"] },
      proof_summary: "complete: stale receipt-only summary"
    }
  });

  const response = await getJson("/api/dashboard");
  const run = db.querySql<{ status: string; metadata_json: string }>("SELECT status, metadata_json FROM runs WHERE id='run_legacy_receipt_complete' LIMIT 1")[0];
  const staleSummaryRun = db.querySql<{ status: string; metadata_json: string }>(
    "SELECT status, metadata_json FROM runs WHERE id='run_legacy_receipt_complete_stale_summary' LIMIT 1"
  )[0];
  const metadata = JSON.parse(run.metadata_json) as { proof_gate: { ok: boolean; missing: string[]; present: string[] }; proof_summary: string };
  const staleSummaryMetadata = JSON.parse(staleSummaryRun.metadata_json) as { proof_summary: string };

  assert.equal(response.status, 200);
  assert.equal(run.status, "partial");
  assert.equal(metadata.proof_gate.ok, false);
  assert.deepEqual(metadata.proof_gate.missing, ["actual_execution_or_manual_verification"]);
  assert.deepEqual(metadata.proof_gate.present, ["worker_receipt"]);
  assert.equal(metadata.proof_summary, "partial: worker receipts captured, actual execution is not verified");
  assert.equal(staleSummaryRun.status, "partial");
  assert.equal(staleSummaryMetadata.proof_summary, "partial: worker receipts captured, actual execution is not verified");
});

test("GET /api/dashboard omits review-run next action for partial runs superseded by later complete runs", async () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM runs; DELETE FROM approvals; DELETE FROM system_checks; DELETE FROM bridge_executions; DELETE FROM bridge_actions; DELETE FROM knowledge_notes;");
  db.insert("runs", {
    id: "run_old_partial_dashboard",
    name: "Codexでdocs/10-obsidian-export.md存在確認のみ。存在したら1文で終了。",
    status: "partial",
    objective: "Codexでdocs/10-obsidian-export.md存在確認のみ。存在したら1文で終了。",
    created_at: "2026-06-12T13:16:00.000Z",
    updated_at: "2026-06-12T13:16:25.000Z",
    metadata_json: {
      proof_summary: "partial: executable Codex proof captured, but receipt-only worker steps still need actual execution or manual verification"
    }
  });
  db.insert("runs", {
    id: "run_later_complete_dashboard",
    name: "Codexでdocs/10-obsidian-export.md存在確認のみ",
    status: "complete",
    objective: "Codexでdocs/10-obsidian-export.md存在確認のみ",
    created_at: "2026-06-12T13:17:00.000Z",
    updated_at: "2026-06-12T13:17:56.000Z",
    metadata_json: {
      proof_summary: "complete: executable worker finished"
    }
  });
  db.insert("system_checks", {
    id: "check_ok_dashboard_superseded",
    kind: "browser_check",
    status: "ok",
    target_url: "http://127.0.0.1:5173",
    summary: "Local screen verified",
    artifact_uri: "file:///tmp/screen.png",
    created_at: "2026-06-12T13:18:00.000Z",
    metadata_json: {}
  });

  const response = await getJson("/api/dashboard");
  const body = JSON.parse(response.body) as {
    runs: Array<{ id: string; status: string }>;
    nextActions: Array<{ id: string; summary: string }>;
  };

  assert.equal(response.status, 200);
  assert.ok(body.runs.some((run) => run.id === "run_old_partial_dashboard" && run.status === "partial"));
  assert.ok(body.runs.some((run) => run.id === "run_later_complete_dashboard" && run.status === "complete"));
  assert.equal(body.nextActions.some((action) => action.id === "review-run"), false);
});

test("GET /api/dashboard uses the latest Daily AI registered workflow run for actionable aggregation", async () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM runs; DELETE FROM approvals; DELETE FROM system_checks; DELETE FROM bridge_executions; DELETE FROM bridge_actions; DELETE FROM knowledge_notes;");
  db.insert("runs", {
    id: "run_daily_ai_older_blocked_direct_dashboard",
    name: "Daily AI older blocked registered workflow run",
    status: "blocked",
    objective: "Daily AI older blocked registered workflow run",
    created_at: "2026-06-18T22:00:00.000Z",
    updated_at: "2026-06-18T22:05:00.000Z",
    metadata_json: {
      registered_workflow_id: "daily-ai-research-publish-run",
      proof_gate: {
        ok: false,
        present: ["daily_ai_runner_started"],
        missing: ["daily_ai_runner_exit_nonzero"]
      }
    }
  });
  db.insert("runs", {
    id: "run_daily_ai_older_blocked_plan_dashboard",
    name: "Daily AI duplicate blocked adapter row",
    status: "blocked",
    objective: "Daily AI duplicate blocked adapter row",
    created_at: "2026-06-18T22:10:00.000Z",
    updated_at: "2026-06-18T22:12:00.000Z",
    metadata_json: {
      plan: { tasks: [{ adapter: "daily_ai_registered" }] },
      proof_gate: {
        ok: false,
        present: ["daily_ai_runner_started"],
        missing: ["daily_ai_publish_receipt"]
      }
    }
  });
  db.insert("runs", {
    id: "run_daily_ai_closeout_partial_dashboard",
    name: "Daily AI closeout partial registered workflow run",
    status: "partial",
    objective: "Daily AI closeout partial registered workflow run",
    created_at: "2026-06-19T02:00:00.000Z",
    updated_at: "2026-06-19T02:10:00.000Z",
    metadata_json: {
      registeredWorkflowId: "daily-ai-research-publish-run",
      run_contract: {
        workflow: "Daily AI",
        mode: "registered",
        visibleSteps: ["Publish receipt", "X engagement proof", "Cleanup receipt"],
        requiredProofs: ["daily_ai_publish_receipt", "daily_ai_x_engagement_proof", "daily_ai_cleanup_receipt"]
      },
      proof_gate: {
        ok: false,
        present: ["daily_ai_publish_receipt", "daily_ai_cleanup_receipt"],
        missing: ["daily_ai_x_engagement_proof"]
      }
    }
  });
  db.insert("system_checks", {
    id: "check_ok_dashboard_daily_ai_latest_registered",
    kind: "browser_check",
    status: "ok",
    target_url: "http://127.0.0.1:5173",
    summary: "Local screen verified",
    artifact_uri: "file:///tmp/screen.png",
    created_at: "2026-06-19T02:11:00.000Z",
    metadata_json: {}
  });

  const response = await getJson("/api/dashboard");
  const body = JSON.parse(response.body) as {
    runs: Array<{ id: string; status: string; metadata_json: string }>;
    actionableRuns: Array<{ id: string; status: string; metadata_json: string }>;
    nextActions: Array<{ id: string; summary: string }>;
    codexAutomationMigrationLedger: {
      items: Array<{
        registeredWorkflowId: string | null;
        latestRunId: string | null;
        latestRunStatus: string | null;
        proofGateOk: boolean;
        missingProofs: string[];
      }>;
    };
  };
  const rawCloseout = body.runs.find((run) => run.id === "run_daily_ai_closeout_partial_dashboard");
  const actionableCloseout = body.actionableRuns.find((run) => run.id === "run_daily_ai_closeout_partial_dashboard");
  const closeoutMetadata = actionableCloseout ? (JSON.parse(actionableCloseout.metadata_json) as Record<string, unknown>) : {};
  const runContractSummary = closeoutMetadata.run_contract_summary as
    | { progress?: { ok?: boolean }; missingVisibleSteps?: string[]; nextVisibleStep?: string }
    | undefined;
  const dailyAiLedgerItem = body.codexAutomationMigrationLedger.items.find((item) => item.registeredWorkflowId === "daily-ai-research-publish-run");

  assert.equal(response.status, 200);
  assert.ok(rawCloseout);
  assert.equal(rawCloseout.status, "partial");
  assert.ok(body.runs.some((run) => run.id === "run_daily_ai_older_blocked_direct_dashboard" && run.status === "blocked"));
  assert.ok(body.runs.some((run) => run.id === "run_daily_ai_older_blocked_plan_dashboard" && run.status === "blocked"));
  assert.equal(actionableCloseout?.status, "partial");
  assert.equal(body.actionableRuns.some((run) => run.id === "run_daily_ai_older_blocked_direct_dashboard"), false);
  assert.equal(body.actionableRuns.some((run) => run.id === "run_daily_ai_older_blocked_plan_dashboard"), false);
  assert.equal(body.nextActions.filter((action) => action.id === "review-run").length, 1);
  assert.equal(runContractSummary?.progress?.ok, false);
  assert.deepEqual(runContractSummary?.missingVisibleSteps, ["X engagement proof"]);
  assert.equal(runContractSummary?.nextVisibleStep, "X engagement proof");
  assert.equal(dailyAiLedgerItem?.latestRunId, "run_daily_ai_closeout_partial_dashboard");
  assert.equal(dailyAiLedgerItem?.latestRunStatus, "partial");
  assert.equal(dailyAiLedgerItem?.proofGateOk, false);
  assert.deepEqual(dailyAiLedgerItem?.missingProofs, ["daily_ai_x_engagement_proof"]);
});

test("GET /api/dashboard keeps stale NisenPrints history out of actionable runs and next actions", async () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM runs; DELETE FROM approvals; DELETE FROM system_checks; DELETE FROM bridge_executions; DELETE FROM bridge_actions; DELETE FROM knowledge_notes;");
  const previousStatePath = process.env.AUTOMATION_OS_NISENPRINTS_STATE_PATH;
  const statePath = join(tempRoot, "nisenprints-dashboard-stale-state.md");
  writeFileSync(
    statePath,
    [
      "# NisenPrints Current State",
      "",
      "- latest active run: `2026-06-17-170503-3a7e-fuji-magnolia-snow-onsen-silver-white-cat`",
      "- final_status: `canva_artifacts_present`",
      "- resume_stage: `printify_product_copy`",
      "- blocker: ``"
    ].join("\n"),
    "utf8"
  );
  process.env.AUTOMATION_OS_NISENPRINTS_STATE_PATH = statePath;
  db.insert("runs", {
    id: "run_stale_nisenprints_dashboard",
    name: "NisenPrints registered workflow billing-only proof gate full publish resume",
    status: "blocked",
    objective:
      "NisenPrints registered workflow billing-only proof gate full publish resume run_id=2026-06-17-170503-3a7e-fuji-magnolia-snow-onsen-silver-white-cat browser_use_registered_runner",
    created_at: "2026-06-17T09:29:00.493Z",
    updated_at: "2026-06-17T09:30:02.567Z",
    metadata_json: {
      executor: "execute_nisenprints_registered",
      run_slug: "2026-06-17-170503-3a7e-fuji-magnolia-snow-onsen-silver-white-cat",
      final_status: "canva_export_blocked",
      resume_stage: "canva_commit_export",
      blocker: "canva_browser_use_download_export_not_implemented",
      stop_reason: "canva_browser_use_download_export_not_implemented"
    }
  });
  db.insert("system_checks", {
    id: "check_ok_dashboard_nisenprints_stale",
    kind: "browser_check",
    status: "ok",
    target_url: "http://127.0.0.1:5173",
    summary: "Local screen verified",
    artifact_uri: "file:///tmp/screen.png",
    created_at: "2026-06-17T09:31:00.000Z",
    metadata_json: {}
  });

  try {
    const response = await getJson("/api/dashboard");
    const body = JSON.parse(response.body) as {
      runs: Array<{ id: string; status: string }>;
      actionableRuns: Array<{ id: string; status: string }>;
      nextActions: Array<{ id: string; summary: string }>;
    };

    assert.equal(response.status, 200);
    assert.ok(body.runs.some((run) => run.id === "run_stale_nisenprints_dashboard" && run.status === "blocked"));
    assert.equal(body.actionableRuns.some((run) => run.id === "run_stale_nisenprints_dashboard"), false);
    assert.equal(body.nextActions.some((action) => action.id === "review-run"), false);
  } finally {
    if (previousStatePath === undefined) delete process.env.AUTOMATION_OS_NISENPRINTS_STATE_PATH;
    else process.env.AUTOMATION_OS_NISENPRINTS_STATE_PATH = previousStatePath;
  }
});

test("GET /api/dashboard builds next actions from the same action queue used by actionableRuns", async () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM runs; DELETE FROM approvals; DELETE FROM system_checks; DELETE FROM bridge_executions; DELETE FROM bridge_actions; DELETE FROM knowledge_notes;");
  db.insert("runs", {
    id: "run_readonly_noise_raw_only",
    name: "read-only local check for dashboard",
    status: "partial",
    objective: "read-only local check for dashboard",
    created_at: "2026-06-17T01:00:00.000Z",
    updated_at: "2026-06-17T01:00:00.000Z",
    metadata_json: {
      worker_mode: "receipt_only",
      proof_summary: "partial: worker receipts captured, actual execution is not verified"
    }
  });
  db.insert("system_checks", {
    id: "check_ok_dashboard_raw_runs",
    kind: "browser_check",
    status: "ok",
    target_url: "http://127.0.0.1:5173",
    summary: "Local screen verified",
    artifact_uri: "file:///tmp/screen.png",
    created_at: "2026-06-17T01:01:00.000Z",
    metadata_json: {}
  });

  const response = await getJson("/api/dashboard");
  const body = JSON.parse(response.body) as {
    runs: Array<{ id: string; metadata_json: string }>;
    actionableRuns: Array<{ id: string }>;
    nextActions: Array<{ id: string; summary: string }>;
  };
  const run = body.runs.find((item) => item.id === "run_readonly_noise_raw_only");
  const returnedMetadata = run ? (JSON.parse(run.metadata_json) as Record<string, unknown>) : {};

  assert.equal(response.status, 200);
  assert.ok(run);
  assert.equal("proof_summary" in returnedMetadata, false);
  assert.equal(body.actionableRuns.some((item) => item.id === "run_readonly_noise_raw_only"), false);
  assert.equal(body.nextActions.some((action) => action.id === "review-run"), false);
});

test("GET /api/dashboard exposes YouTube capture retry command without duplicate review action", async () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM runs; DELETE FROM approvals; DELETE FROM system_checks; DELETE FROM bridge_executions; DELETE FROM bridge_actions; DELETE FROM knowledge_notes;");
  db.insert("runs", {
    id: "run_youtube_retry_next_action",
    name: "この動画を台本化して要点を調べて https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    status: "partial",
    objective: "この動画を台本化して要点を調べて https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    created_at: "2026-06-20T11:02:53.000Z",
    updated_at: "2026-06-20T11:02:53.000Z",
    metadata_json: {
      youtube_capture: {
        status: "blocked",
        requestedUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        exactBlocker: "youtube_transcript_official_panel_not_visible",
        summary: "blocked"
      },
      public_next_action: {
        id: "retry-youtube-transcript",
        title: "YouTube台本を再確認",
        summary: "公式の台本欄が表示されなかったため、別の取得方法か動画候補の確認に進めます。",
        buttonLabel: "新規作成へ",
        view: "Create",
        command: "この動画を台本化して要点を調べて https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        severity: "attention"
      }
    }
  });
  db.insert("system_checks", {
    id: "check_ok_dashboard_youtube_retry",
    kind: "browser_check",
    status: "ok",
    target_url: "http://127.0.0.1:5173",
    summary: "Local screen verified",
    artifact_uri: "file:///tmp/screen.png",
    created_at: "2026-06-20T11:03:00.000Z",
    metadata_json: {}
  });

  const response = await getJson("/api/dashboard");
  const body = JSON.parse(response.body) as {
    actionableRuns: Array<{ id: string }>;
    nextActions: Array<{ id: string; view: string; command?: string }>;
  };
  const retryAction = body.nextActions.find((action) => action.id === "retry-youtube-transcript");

  assert.equal(response.status, 200);
  assert.deepEqual(body.actionableRuns.map((run) => run.id), ["run_youtube_retry_next_action"]);
  assert.equal(retryAction?.view, "Create");
  assert.equal(retryAction?.command, "この動画を台本化して要点を調べて https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(body.nextActions.some((action) => action.id === "review-run"), false);
});

test("markRunsResumeSuppressed safely merges metadata for explicit historical noise run ids", () => {
  db.initDb();
  db.resetDemoData();
  db.insert("runs", {
    id: "run_noise_to_suppress",
    name: "Historical read-only noise",
    status: "partial",
    objective: "Historical read-only noise",
    created_at: "2026-06-17T02:00:00.000Z",
    updated_at: "2026-06-17T02:00:00.000Z",
    metadata_json: {
      worker_mode: "receipt_only",
      existing_flag: true
    }
  });

  const result = markRunsResumeSuppressed(["run_noise_to_suppress", "run_noise_to_suppress", "missing_run"], {
    reason: "historical_readonly_noise",
    suppressedAt: "2026-06-17T02:05:00.000Z"
  });
  const run = db.querySql<{ status: string; metadata_json: string }>("SELECT status, metadata_json FROM runs WHERE id='run_noise_to_suppress' LIMIT 1")[0];
  const metadata = JSON.parse(run.metadata_json) as Record<string, unknown>;

  assert.deepEqual(result.requested, ["run_noise_to_suppress", "missing_run"]);
  assert.deepEqual(result.updated, ["run_noise_to_suppress"]);
  assert.deepEqual(result.missing, ["missing_run"]);
  assert.equal(run.status, "partial");
  assert.equal(metadata.existing_flag, true);
  assert.equal(metadata.resume_suppressed, true);
  assert.equal(metadata.resume_suppressed_reason, "historical_readonly_noise");
  assert.equal(metadata.resume_suppressed_at, "2026-06-17T02:05:00.000Z");
});

test("Trusted Bridge actions list safe and billing-only capabilities", async () => {
  db.initDb();
  db.resetDemoData();
  const response = await getJson("/api/bridge/actions");
  const body = JSON.parse(response.body) as { actions: Array<{ id: string; status: string; riskLevel: string }> };

  assert.equal(response.status, 200);
  assert.ok(body.actions.some((action) => action.id === "local_browser_check" && action.status === "ready"));
  assert.ok(body.actions.some((action) => action.id === "browser_use_local_check" && action.status === "ready"));
  assert.ok(body.actions.some((action) => action.id === "second_brain_process" && action.status === "ready" && action.riskLevel === "safe"));
  assert.ok(body.actions.some((action) => action.id === "chrome_authenticated_action" && action.status === "ready"));
});

test("Trusted Bridge second_brain_process runs safely without approval and records processor counts", async () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM approvals; DELETE FROM bridge_actions; DELETE FROM knowledge_notes;");
  const previousVault = process.env.AUTOMATION_OS_OBSIDIAN_VAULT;
  const previousProcessorStatus = process.env.AUTOMATION_OS_SECOND_BRAIN_PROCESSOR_STATUS_FILE;
  const previousAutoExport = process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT;
  const previousObsidianStatus = process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE;
  const vaultPath = join(tempRoot, "bridge-second-brain-vault");
  const processorStatusFile = join(tempRoot, "bridge-second-brain-processor-status.json");
  process.env.AUTOMATION_OS_OBSIDIAN_VAULT = vaultPath;
  process.env.AUTOMATION_OS_SECOND_BRAIN_PROCESSOR_STATUS_FILE = processorStatusFile;
  process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT = "0";
  process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE = join(tempRoot, "bridge-second-brain-obsidian-status.json");
  mkdirSync(join(vaultPath, "09_Inbox"), { recursive: true });
  writeFileSync(
    join(vaultPath, "09_Inbox", "Bridge Capture.md"),
    "---\ntitle: Bridge Capture\nauto_process: obsidian_internal_only\nsuggested_destination: 09_Inbox\n---\n# Bridge Capture\n\nProcess from bridge.\n"
  );

  try {
    const response = await postJson("/api/bridge/actions/second_brain_process/run", {});
    const body = JSON.parse(response.body) as {
      status: string;
      metadata: {
        mode: string;
        apply: boolean;
        updated: number;
        wouldUpdate: number;
        unchanged: number;
        skipped: number;
        blocked: number;
        scanned: number;
        eligible: number;
        statusFile: string;
        processedAt: string;
        results: Array<{ file: string; status: string; reason: string; suggestedDestination?: string; backupFile?: string }>;
      };
    };
    const approvals = db.querySql<{ count: number }>("SELECT count(*) as count FROM approvals");
    const receipts = db.querySql<{ capability_id: string; status: string; metadata_json: string }>(
      "SELECT capability_id, status, metadata_json FROM bridge_actions WHERE capability_id='second_brain_process' ORDER BY created_at DESC LIMIT 1"
    );
    const metadata = JSON.parse(receipts[0].metadata_json) as {
      mode: string;
      apply: boolean;
      updated: number;
      wouldUpdate: number;
      skipped: number;
      blocked: number;
      scanned: number;
      eligible: number;
      statusFile: string;
      processedAt: string;
      results: Array<{ file: string; status: string; reason: string; suggestedDestination?: string; backupFile?: string }>;
    };

    assert.equal(response.status, 200);
    assert.equal(body.status, "ok");
    assert.equal(body.metadata.mode, "apply");
    assert.equal(body.metadata.apply, true);
    assert.equal(body.metadata.updated, 1);
    assert.equal(body.metadata.wouldUpdate, 0);
    assert.equal(body.metadata.skipped, 0);
    assert.equal(body.metadata.blocked, 0);
    assert.equal(body.metadata.scanned, 1);
    assert.equal(body.metadata.eligible, 1);
    assert.equal(body.metadata.statusFile, processorStatusFile);
    assert.ok(body.metadata.processedAt);
    assert.equal(body.metadata.results[0]?.file, join("09_Inbox", "Bridge Capture.md"));
    assert.equal(body.metadata.results[0]?.status, "updated");
    assert.equal(body.metadata.results[0]?.reason, "frontmatter_updated");
    assert.equal(body.metadata.results[0]?.suggestedDestination, "09_Inbox");
    assert.ok(body.metadata.results[0]?.backupFile);
    assert.equal(approvals[0].count, 0);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].status, "ok");
    assert.equal(metadata.mode, "apply");
    assert.equal(metadata.updated, 1);
    assert.equal(metadata.statusFile, processorStatusFile);
    assert.ok(metadata.processedAt);
    assert.equal(metadata.results[0]?.backupFile, body.metadata.results[0]?.backupFile);
    const afterFirst = readFileSync(join(vaultPath, "09_Inbox", "Bridge Capture.md"), "utf8");
    const firstProcessedAt = afterFirst.match(/processed_at: "([^"]+)"/)?.[1];
    assert.match(afterFirst, /processing_status: review_ready/);
    assert.ok(firstProcessedAt);
    assert.equal(countFiles(join(vaultPath, ".backups", "second-brain-processor")), 1);

    const secondResponse = await postJson("/api/bridge/actions/second_brain_process/run", {});
    const secondBody = JSON.parse(secondResponse.body) as {
      status: string;
      metadata: {
        mode: string;
        apply: boolean;
        updated: number;
        unchanged: number;
        skipped: number;
        blocked: number;
        scanned: number;
        eligible: number;
        statusFile: string;
        processedAt: string;
        results: Array<{ file: string; status: string; reason: string; suggestedDestination?: string; backupFile?: string }>;
      };
    };
    const secondReceipts = db.querySql<{ capability_id: string; status: string; metadata_json: string }>(
      "SELECT capability_id, status, metadata_json FROM bridge_actions WHERE capability_id='second_brain_process' ORDER BY created_at DESC LIMIT 1"
    );
    const secondMetadata = JSON.parse(secondReceipts[0].metadata_json) as {
      mode: string;
      apply: boolean;
      updated: number;
      unchanged: number;
      statusFile: string;
      processedAt: string;
      results: Array<{ file: string; status: string; reason: string; suggestedDestination?: string; backupFile?: string }>;
    };
    const afterSecond = readFileSync(join(vaultPath, "09_Inbox", "Bridge Capture.md"), "utf8");

    assert.equal(secondResponse.status, 200);
    assert.equal(secondBody.status, "ok");
    assert.equal(secondBody.metadata.mode, "apply");
    assert.equal(secondBody.metadata.apply, true);
    assert.equal(secondBody.metadata.updated, 0);
    assert.equal(secondBody.metadata.unchanged, 1);
    assert.equal(secondBody.metadata.skipped, 0);
    assert.equal(secondBody.metadata.blocked, 0);
    assert.equal(secondBody.metadata.scanned, 1);
    assert.equal(secondBody.metadata.eligible, 1);
    assert.equal(secondBody.metadata.statusFile, processorStatusFile);
    assert.equal(secondBody.metadata.results[0]?.status, "unchanged");
    assert.equal(secondBody.metadata.results[0]?.reason, "already_review_ready");
    assert.equal(secondBody.metadata.results[0]?.backupFile, undefined);
    assert.equal(secondReceipts[0].status, "ok");
    assert.equal(secondMetadata.mode, "apply");
    assert.equal(secondMetadata.updated, 0);
    assert.equal(secondMetadata.unchanged, 1);
    assert.equal(secondMetadata.results[0]?.status, "unchanged");
    assert.equal(afterSecond, afterFirst);
    assert.equal(afterSecond.match(/processed_at: "([^"]+)"/)?.[1], firstProcessedAt);
    assert.equal(countFiles(join(vaultPath, ".backups", "second-brain-processor")), 1);
  } finally {
    if (previousVault === undefined) delete process.env.AUTOMATION_OS_OBSIDIAN_VAULT;
    else process.env.AUTOMATION_OS_OBSIDIAN_VAULT = previousVault;
    if (previousProcessorStatus === undefined) delete process.env.AUTOMATION_OS_SECOND_BRAIN_PROCESSOR_STATUS_FILE;
    else process.env.AUTOMATION_OS_SECOND_BRAIN_PROCESSOR_STATUS_FILE = previousProcessorStatus;
    if (previousAutoExport === undefined) delete process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT;
    else process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT = previousAutoExport;
    if (previousObsidianStatus === undefined) delete process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE;
    else process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE = previousObsidianStatus;
  }
});

test("Trusted Bridge second_brain_process prepare is dry-run and records per-file proof without mutation", async () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM approvals; DELETE FROM bridge_actions; DELETE FROM knowledge_notes;");
  const previousVault = process.env.AUTOMATION_OS_OBSIDIAN_VAULT;
  const previousProcessorStatus = process.env.AUTOMATION_OS_SECOND_BRAIN_PROCESSOR_STATUS_FILE;
  const previousAutoExport = process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT;
  const previousObsidianStatus = process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE;
  const vaultPath = join(tempRoot, "bridge-second-brain-prepare-vault");
  const processorStatusFile = join(tempRoot, "bridge-second-brain-prepare-status.json");
  process.env.AUTOMATION_OS_OBSIDIAN_VAULT = vaultPath;
  process.env.AUTOMATION_OS_SECOND_BRAIN_PROCESSOR_STATUS_FILE = processorStatusFile;
  process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT = "0";
  process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE = join(tempRoot, "bridge-second-brain-prepare-obsidian-status.json");
  mkdirSync(join(vaultPath, "09_Inbox"), { recursive: true });
  const notePath = join(vaultPath, "09_Inbox", "Prepare Capture.md");
  writeFileSync(
    notePath,
    "---\ntitle: Prepare Capture\nauto_process: obsidian_internal_only\nsuggested_destination: 06_Research\n---\n# Prepare Capture\n\nPrepare only.\n"
  );
  const before = readFileSync(notePath, "utf8");

  try {
    const response = await postJson("/api/bridge/actions/second_brain_process/prepare", {});
    const body = JSON.parse(response.body) as {
      status: string;
      metadata: {
        mode: string;
        apply: boolean;
        updated: number;
        wouldUpdate: number;
        statusFile: string | null;
        results: Array<{ file: string; status: string; reason: string; suggestedDestination?: string; backupFile?: string }>;
      };
      secondBrainProcessor: { apply: boolean; updated: number; wouldUpdate: number; statusFile?: string };
    };
    const receipts = db.querySql<{ status: string; metadata_json: string }>(
      "SELECT status, metadata_json FROM bridge_actions WHERE capability_id='second_brain_process' ORDER BY created_at DESC LIMIT 1"
    );
    const metadata = JSON.parse(receipts[0].metadata_json) as {
      mode: string;
      apply: boolean;
      results: Array<{ file: string; status: string; reason: string; suggestedDestination?: string; backupFile?: string }>;
    };

    assert.equal(response.status, 200);
    assert.equal(body.status, "ok");
    assert.equal(body.metadata.mode, "dry_run");
    assert.equal(body.metadata.apply, false);
    assert.equal(body.metadata.updated, 0);
    assert.equal(body.metadata.wouldUpdate, 1);
    assert.equal(body.metadata.statusFile, null);
    assert.equal(body.secondBrainProcessor.apply, false);
    assert.equal(body.secondBrainProcessor.statusFile, undefined);
    assert.deepEqual(body.metadata.results[0], {
      file: join("09_Inbox", "Prepare Capture.md"),
      status: "would_update",
      reason: "dry_run",
      suggestedDestination: "06_Research"
    });
    assert.equal(receipts[0].status, "ok");
    assert.equal(metadata.mode, "dry_run");
    assert.equal(metadata.apply, false);
    assert.equal(metadata.results[0]?.status, "would_update");
    assert.equal(readFileSync(notePath, "utf8"), before);
    assert.equal(existsSync(processorStatusFile), false);
    assert.equal(existsSync(join(vaultPath, ".backups")), false);
  } finally {
    if (previousVault === undefined) delete process.env.AUTOMATION_OS_OBSIDIAN_VAULT;
    else process.env.AUTOMATION_OS_OBSIDIAN_VAULT = previousVault;
    if (previousProcessorStatus === undefined) delete process.env.AUTOMATION_OS_SECOND_BRAIN_PROCESSOR_STATUS_FILE;
    else process.env.AUTOMATION_OS_SECOND_BRAIN_PROCESSOR_STATUS_FILE = previousProcessorStatus;
    if (previousAutoExport === undefined) delete process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT;
    else process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT = previousAutoExport;
    if (previousObsidianStatus === undefined) delete process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE;
    else process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE = previousObsidianStatus;
  }
});

test("Trusted Bridge second_brain_process refuses custom env vault without explicit override", async () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM bridge_actions;");
  const previousVault = process.env.AUTOMATION_OS_OBSIDIAN_VAULT;
  const previousAllow = process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT;
  const previousAutoExport = process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT;
  const vaultPath = join(tempRoot, "bridge-second-brain-custom-env-refused");
  process.env.AUTOMATION_OS_OBSIDIAN_VAULT = vaultPath;
  process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT = "0";
  process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT = "0";
  mkdirSync(join(vaultPath, "09_Inbox"), { recursive: true });
  const notePath = join(vaultPath, "09_Inbox", "Blocked Env.md");
  writeFileSync(notePath, "---\ntitle: Blocked Env\nauto_process: obsidian_internal_only\n---\n# Blocked Env\n\nMust stay unchanged.\n");
  const before = readFileSync(notePath, "utf8");

  try {
    const response = await postJson("/api/bridge/actions/second_brain_process/run", {});
    const body = JSON.parse(response.body) as {
      error: string;
      status: string;
      metadata: {
        error: string;
        summary: string;
        mode: string;
        apply: boolean;
        scanned: number;
        eligible: number;
        updated: number;
        wouldUpdate: number;
        unchanged: number;
        skipped: number;
        blocked: number;
        statusFile: string | null;
        processedAt: string;
        results: Array<{ file: string; status: string; reason: string }>;
      };
    };
    const receipts = db.querySql<{ status: string; metadata_json: string }>(
      "SELECT status, metadata_json FROM bridge_actions WHERE capability_id='second_brain_process' ORDER BY created_at DESC LIMIT 1"
    );
    const metadata = JSON.parse(receipts[0].metadata_json) as {
      error: string;
      summary: string;
      mode: string;
      apply: boolean;
      scanned: number;
      eligible: number;
      updated: number;
      wouldUpdate: number;
      unchanged: number;
      skipped: number;
      blocked: number;
      statusFile: string | null;
      processedAt: string;
      results: Array<{ file: string; status: string; reason: string }>;
    };

    assert.equal(response.status, 403);
    assert.equal(body.error, "obsidian_custom_export_requires_approval");
    assert.equal(body.status, "blocked");
    assert.equal(body.metadata.mode, "apply");
    assert.equal(body.metadata.apply, true);
    assert.equal(body.metadata.summary, "custom vault selection requires AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT=1");
    assert.equal(body.metadata.scanned, 0);
    assert.equal(body.metadata.eligible, 0);
    assert.equal(body.metadata.updated, 0);
    assert.equal(body.metadata.wouldUpdate, 0);
    assert.equal(body.metadata.unchanged, 0);
    assert.equal(body.metadata.skipped, 0);
    assert.equal(body.metadata.blocked, 1);
    assert.equal(body.metadata.statusFile, null);
    assert.ok(body.metadata.processedAt);
    assert.deepEqual(body.metadata.results, [{ file: ".", status: "blocked", reason: "obsidian_custom_export_requires_approval" }]);
    assert.equal(receipts[0].status, "blocked");
    assert.equal(metadata.error, "obsidian_custom_export_requires_approval");
    assert.equal(metadata.summary, "custom vault selection requires AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT=1");
    assert.equal(metadata.scanned, 0);
    assert.equal(metadata.eligible, 0);
    assert.equal(metadata.updated, 0);
    assert.equal(metadata.wouldUpdate, 0);
    assert.equal(metadata.unchanged, 0);
    assert.equal(metadata.skipped, 0);
    assert.equal(metadata.blocked, 1);
    assert.equal(metadata.statusFile, null);
    assert.ok(metadata.processedAt);
    assert.deepEqual(metadata.results, [{ file: ".", status: "blocked", reason: "obsidian_custom_export_requires_approval" }]);
    assert.equal(readFileSync(notePath, "utf8"), before);
  } finally {
    if (previousVault === undefined) delete process.env.AUTOMATION_OS_OBSIDIAN_VAULT;
    else process.env.AUTOMATION_OS_OBSIDIAN_VAULT = previousVault;
    if (previousAllow === undefined) delete process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT;
    else process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT = previousAllow;
    if (previousAutoExport === undefined) delete process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT;
    else process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT = previousAutoExport;
  }
});

test("Trusted Bridge non-billing external action does not create approval", async () => {
  db.initDb();
  db.resetDemoData();
  const response = await postJson("/api/bridge/actions/chrome_authenticated_action/prepare", {});
  const body = JSON.parse(response.body) as { status: string; metadata: { approvalId?: string; bridgeStatus?: string } };
  const approvals = db.querySql<{ id: string; status: string }>("SELECT id, status FROM approvals WHERE requested_by='trusted-bridge'");
  const receipts = db.querySql<{ capability_id: string; status: string }>(
    "SELECT capability_id, status FROM bridge_actions WHERE capability_id='chrome_authenticated_action'"
  );

  assert.equal(response.status, 409);
  assert.equal(body.status, "blocked");
  assert.equal(body.metadata.approvalId, undefined);
  assert.equal(body.metadata.bridgeStatus, "ready");
  assert.equal(approvals.length, 0);
  assert.equal(receipts[0].capability_id, "chrome_authenticated_action");
  assert.equal(receipts[0].status, "blocked");
});

test("Trusted Bridge execute is not required for non-billing ready actions", async () => {
  db.initDb();
  db.resetDemoData();
  const response = await postJson("/api/bridge/actions/chrome_authenticated_action/execute", {});
  const body = JSON.parse(response.body) as { error: string };

  assert.equal(response.status, 400);
  assert.equal(body.error, "bridge_execute_not_required");
});

test("Trusted Bridge execute does not create approval executor for non-billing ready actions", async () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM bridge_executions;");
  const execute = await postJson("/api/bridge/actions/chrome_authenticated_action/execute", {});
  const executeBody = JSON.parse(execute.body) as { error: string };
  const rows = db.querySql<{ id: string }>("SELECT id FROM bridge_executions");

  assert.equal(execute.status, 400);
  assert.equal(executeBody.error, "bridge_execute_not_required");
  assert.equal(rows.length, 0);
});

test("POST /api/knowledge/refresh creates reusable Obsidian knowledge notes", async () => {
  db.initDb();
  db.resetDemoData();
  const response = await postJson("/api/knowledge/refresh", {});
  const body = JSON.parse(response.body) as { ok: boolean; notes: Array<{ id: string }> };
  const rows = db.querySql<{ id: string }>("SELECT id FROM knowledge_notes ORDER BY id");

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.ok(body.notes.length >= 4);
  assert.ok(rows.some((row) => row.id === "knowledge_bridge_snapshot"));
});

test("POST /api/knowledge/refresh does not run inline Obsidian export", async () => {
  db.initDb();
  db.resetDemoData();
  const previousAutoExport = process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT;
  const previousVault = process.env.AUTOMATION_OS_OBSIDIAN_VAULT;
  const previousStatusFile = process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE;
  const statusFile = join(tempRoot, "knowledge-refresh-no-inline-export-status.json");
  process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT = "1";
  process.env.AUTOMATION_OS_OBSIDIAN_VAULT = join(tempRoot, "knowledge-refresh-no-inline-export-vault");
  process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE = statusFile;

  try {
    const response = await postJson("/api/knowledge/refresh", {});
    const dashboardResponse = await getJson("/api/dashboard");
    const rows = db.querySql<{ id: string }>("SELECT id FROM knowledge_notes ORDER BY id");
    const dashboard = JSON.parse(dashboardResponse.body) as { knowledgeNotes: Array<{ id: string }> };

    assert.equal(response.status, 200);
    assert.equal(dashboardResponse.status, 200);
    assert.ok(rows.some((row) => row.id === "knowledge_ui_verification_snapshot"));
    assert.ok(dashboard.knowledgeNotes.some((note) => note.id === "knowledge_ui_verification_snapshot"));
    assert.equal(existsSync(statusFile), false);
  } finally {
    if (previousAutoExport === undefined) delete process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT;
    else process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT = previousAutoExport;
    if (previousVault === undefined) delete process.env.AUTOMATION_OS_OBSIDIAN_VAULT;
    else process.env.AUTOMATION_OS_OBSIDIAN_VAULT = previousVault;
    if (previousStatusFile === undefined) delete process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE;
    else process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE = previousStatusFile;
  }
});

test("topbar start API path defers Obsidian export until after the immediate dashboard refresh", async () => {
  db.initDb();
  db.resetDemoData();
  const previousAutoExport = process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT;
  const previousVault = process.env.AUTOMATION_OS_OBSIDIAN_VAULT;
  const previousStatusFile = process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE;
  const previousDeferMs = process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT_DEFER_MS;
  const statusFile = join(tempRoot, "topbar-start-deferred-export-status.json");
  process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT = "1";
  process.env.AUTOMATION_OS_OBSIDIAN_VAULT = join(tempRoot, "topbar-start-deferred-export-vault");
  process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE = statusFile;
  process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT_DEFER_MS = "50";

  try {
    const token = "sk-topbarDeferred1234567890abcdefghijklmnopqrstuvwxyzABCD";
    const secretsResponse = await postJson("/api/secrets/from-message", { text: `OpenAI API key: ${token}` });
    const runResponse = await postJson("/api/runs/start", { command: "Daily AI run with saved key" });
    const dashboardResponse = await getJson("/api/dashboard");
    const dashboard = JSON.parse(dashboardResponse.body) as { knowledgeNotes: Array<{ id: string }>; runs: Array<{ id: string }> };

    assert.equal(secretsResponse.status, 200);
    assert.equal(runResponse.status, 202);
    assert.equal(dashboardResponse.status, 200);
    assert.ok(dashboard.knowledgeNotes.some((note) => note.id === "knowledge_credentials_snapshot"));
    assert.ok(dashboard.runs.length > 0);
    assert.equal(existsSync(statusFile), false, "immediate dashboard refresh must not wait for Obsidian export");

    await waitFor(() => existsSync(statusFile), 10000);
    const persisted = JSON.parse(readFileSync(statusFile, "utf8")) as { ok?: boolean; reason?: string };
    assert.equal(persisted.ok, true);
    assert.equal(persisted.reason, "run-started");
  } finally {
    if (previousAutoExport === undefined) delete process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT;
    else process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT = previousAutoExport;
    if (previousVault === undefined) delete process.env.AUTOMATION_OS_OBSIDIAN_VAULT;
    else process.env.AUTOMATION_OS_OBSIDIAN_VAULT = previousVault;
    if (previousStatusFile === undefined) delete process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE;
    else process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE = previousStatusFile;
    if (previousDeferMs === undefined) delete process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT_DEFER_MS;
    else process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT_DEFER_MS = previousDeferMs;
  }
});

test("knowledge refresh hides saved credential values from notes", () => {
  db.initDb();
  db.resetDemoData();
  const token = "sample_value_1234567890ABCDEF";
  const saved = secrets.saveSecretsFromMessage(`OpenAI APIキーは ${token} です`);
  const response = knowledge.refreshKnowledgeNotes();
  const rows = db.querySql<{ body: string }>("SELECT body FROM knowledge_notes WHERE id='knowledge_credentials_snapshot' LIMIT 1");

  assert.equal(saved.stored.length, 1);
  assert.equal(response.ok, true);
  assert.equal(rows.length, 1);
  assert.match(rows[0].body, /OpenAI APIキー: saved, value hidden/);
  assert.doesNotMatch(rows[0].body, /sk-test|ABCD|abcdefghijklmnopqrstuvwxyz/);
});

function getJson(path: string) {
  return request("GET", path);
}

function postJson(path: string, payload: Record<string, unknown>) {
  return request("POST", path, payload);
}

function patchJson(path: string, payload: Record<string, unknown>) {
  return request("PATCH", path, payload);
}

function assertPublicRegisteredWorkflowRow(workflow: Record<string, unknown>) {
  assert.deepEqual(Object.keys(workflow).sort(), publicRegisteredWorkflowKeys);
  assert.equal(typeof workflow.id, "string");
  assert.equal(typeof workflow.name, "string");
  assert.equal(typeof workflow.status, "string");
  assert.equal(typeof workflow.schedule_label, "string");
  assert.equal(typeof workflow.boundary_label, "string");
  assert.equal(typeof workflow.needs_check, "boolean");
  assert.equal(typeof workflow.last_action_label, "string");
  assert.ok(typeof workflow.last_run_id === "string" || workflow.last_run_id === null);
  assert.equal(typeof workflow.last_result_label, "string");
  assert.equal(typeof workflow.next_action_label, "string");
  assert.ok(["Runs", "Approvals", "Schedule"].includes(String(workflow.next_action_view)));
  assert.ok(["billing_only", "review"].includes(String(workflow.safety_kind)));
  assert.ok(["課金停止", "確認"].includes(String(workflow.safety_label)));
  assert.ok(["none", "billing", "boundary", "proof", "runner", "schedule"].includes(String(workflow.check_kind)));
  assert.ok(["OK", "承認", "境界", "記録", "接続", "予定"].includes(String(workflow.check_label)));
  assert.ok(["high", "medium", "low", "unknown"].includes(String(workflow.trust_kind)));
  assert.ok(["信頼", "境界", "要確認", "未確認"].includes(String(workflow.trust_label)));
  assert.ok(["fresh", "recent", "stale", "unknown"].includes(String(workflow.freshness_kind)));
  assert.ok(["新", "最近", "古い", "未"].includes(String(workflow.freshness_label)));
  for (const key of internalRegisteredWorkflowKeys) {
    assert.equal(workflow[key], undefined);
  }
}

function insertResearchPlannerReviewWorkflows(count: number, status: "active" | "inactive" = "active") {
  const now = db.nowIso();
  for (let index = 1; index <= count; index += 1) {
    const id = `research-plan-api-review-${status}-${index}`;
    db.insert("registered_workflows", {
      id,
      name: `Research Planner review ${index}`,
      status,
      runner_status: "connected",
      runner_kind: "research_plan_registered",
      project_root: "/Users/nichikatanaka/Documents/Codex/automation-os",
      start_command_json: {
        command: `Research Planner review ${index}`,
        source: "research_plan",
        researchPlanId: `api-review-${index}`,
        visibleFlow: ["確認する"]
      },
      schedule_json: {
        kind: "cron",
        rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
        timezone: "Asia/Taipei",
        label: "毎日 09:00"
      },
      source_refs_json: [{ type: "research_plan", path: `research_plans:api-review-${index}`, researchPlanId: `api-review-${index}` }],
      provenance_json: {
        source: "research_plan_regularized",
        researchPlanId: `api-review-${index}`,
        demoCheckId: null,
        codexAppContinuousSync: true,
        snapshotRole: "scheduled_entry_not_completion_proof"
      },
      created_at: now,
      updated_at: now
    });
  }
}

function assertPublicRegisteredWorkflowRows(workflows: Array<Record<string, unknown>>) {
  assert.ok(workflows.length > 0);
  for (const workflow of workflows) assertPublicRegisteredWorkflowRow(workflow);
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (true) {
    if (predicate()) return;
    if (Date.now() - started >= timeoutMs) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out after ${timeoutMs}ms`);
}

function countFiles(path: string): number {
  if (!existsSync(path)) return 0;
  return readdirSync(path, { withFileTypes: true }).reduce((count, entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return count + countFiles(child);
    return entry.isFile() ? count + 1 : count;
  }, 0);
}

function createDeepFanoutArtifacts(root: string, depth: number, maxDepth: number, fanout: number): void {
  if (depth >= maxDepth) {
    writeFileSync(join(root, `proof-${depth}.json`), "{}\n");
    return;
  }
  for (let index = 0; index < fanout; index += 1) {
    const child = join(root, `dir-${depth}-${String(index).padStart(2, "0")}`);
    mkdirSync(child, { recursive: true });
    createDeepFanoutArtifacts(child, depth + 1, maxDepth, fanout);
  }
}

function installBrowserUseFakeCli(name: string): () => void {
  const previousCli = process.env.AUTOMATION_OS_BROWSER_USE_CLI;
  const previousArtifactDir = process.env.AUTOMATION_OS_BROWSER_USE_ARTIFACT_DIR;
  const browserUseCli = join(tempRoot, `${name}.sh`);
  writeFileSync(
    browserUseCli,
    `#!/bin/sh
set -eu
last=""
for arg in "$@"; do last="$arg"; done
case " $* " in
  *" state "*) printf '%s\\n' 'url: http://127.0.0.1:5173/#lanes';;
  *" screenshot "*) printf '%s' 'png' > "$last"; printf '%s\\n' 'saved screenshot';;
  *" open "*) printf '%s\\n' 'opened';;
  *) printf '%s\\n' 'ok';;
esac
`,
    "utf8"
  );
  chmodSync(browserUseCli, 0o755);
  process.env.AUTOMATION_OS_BROWSER_USE_CLI = browserUseCli;
  process.env.AUTOMATION_OS_BROWSER_USE_ARTIFACT_DIR = join(tempRoot, `${name}-artifacts`);
  return () => {
    if (previousCli === undefined) delete process.env.AUTOMATION_OS_BROWSER_USE_CLI;
    else process.env.AUTOMATION_OS_BROWSER_USE_CLI = previousCli;
    if (previousArtifactDir === undefined) delete process.env.AUTOMATION_OS_BROWSER_USE_ARTIFACT_DIR;
    else process.env.AUTOMATION_OS_BROWSER_USE_ARTIFACT_DIR = previousArtifactDir;
  };
}

function installBrowserUseRecordingQaHealthEnv(input: {
  browserUseCli: string;
  recordingSidecar: string;
  geminiRunner: string;
  cdpUrl: string;
  geminiApiKey?: string;
  fakeFfmpeg: boolean;
  createSidecarExecutable?: boolean;
  createGeminiRunnerExecutable?: boolean;
}): () => void {
  const previous = {
    browserUseCli: process.env.AUTOMATION_OS_BROWSER_USE_CLI,
    recordingSidecar: process.env.AUTOMATION_OS_BROWSER_USE_RECORDING_SIDECAR,
    geminiRunner: process.env.AUTOMATION_OS_BROWSER_USE_GEMINI_QA_RUNNER,
    geminiApiKey: process.env.GEMINI_API_KEY,
    cdpUrl: process.env.AUTOMATION_OS_BROWSER_USE_CDP_URL,
    cdpPort: process.env.AUTOMATION_OS_BROWSER_USE_CDP_PORT,
    browserUseCdpUrl: process.env.BROWSER_USE_CDP_URL,
    path: process.env.PATH
  };
  process.env.AUTOMATION_OS_BROWSER_USE_CLI = input.browserUseCli;
  process.env.AUTOMATION_OS_BROWSER_USE_RECORDING_SIDECAR = input.recordingSidecar;
  process.env.AUTOMATION_OS_BROWSER_USE_GEMINI_QA_RUNNER = input.geminiRunner;
  if (input.createSidecarExecutable !== false && input.recordingSidecar) writeExecutable(input.recordingSidecar);
  if (input.createGeminiRunnerExecutable !== false && input.geminiRunner) writeExecutable(input.geminiRunner);
  if (input.geminiApiKey === undefined) process.env.GEMINI_API_KEY = "test-gemini-key";
  else if (input.geminiApiKey) process.env.GEMINI_API_KEY = input.geminiApiKey;
  else delete process.env.GEMINI_API_KEY;
  process.env.AUTOMATION_OS_BROWSER_USE_CDP_URL = input.cdpUrl;
  delete process.env.AUTOMATION_OS_BROWSER_USE_CDP_PORT;
  delete process.env.BROWSER_USE_CDP_URL;

  if (input.fakeFfmpeg) {
    const binDir = join(tempRoot, "health-fake-bin");
    mkdirSync(binDir, { recursive: true });
    const ffmpeg = join(binDir, "ffmpeg");
    writeFileSync(ffmpeg, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(ffmpeg, 0o755);
    process.env.PATH = `${binDir}:${previous.path ?? ""}`;
  }

  return () => {
    restoreEnv("AUTOMATION_OS_BROWSER_USE_CLI", previous.browserUseCli);
    restoreEnv("AUTOMATION_OS_BROWSER_USE_RECORDING_SIDECAR", previous.recordingSidecar);
    restoreEnv("AUTOMATION_OS_BROWSER_USE_GEMINI_QA_RUNNER", previous.geminiRunner);
    restoreEnv("GEMINI_API_KEY", previous.geminiApiKey);
    restoreEnv("AUTOMATION_OS_BROWSER_USE_CDP_URL", previous.cdpUrl);
    restoreEnv("AUTOMATION_OS_BROWSER_USE_CDP_PORT", previous.cdpPort);
    restoreEnv("BROWSER_USE_CDP_URL", previous.browserUseCdpUrl);
    restoreEnv("PATH", previous.path);
  };
}

function writeExecutable(path: string): void {
  writeFileSync(path, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(path, 0o755);
}

function installBrowserUseSidecarFakeCli(name: string): () => void {
  const previousCli = process.env.AUTOMATION_OS_BROWSER_USE_CLI;
  const previousArtifactDir = process.env.AUTOMATION_OS_BROWSER_USE_ARTIFACT_DIR;
  const previousSidecar = process.env.AUTOMATION_OS_BROWSER_USE_RECORDING_SIDECAR;
  const browserUseCli = join(tempRoot, `${name}.sh`);
  const sidecarCli = join(tempRoot, `${name}-recording-sidecar.sh`);
  writeFileSync(
    browserUseCli,
    `#!/bin/sh
set -eu
last=""
for arg in "$@"; do last="$arg"; done
case " $* " in
  *" state "*) printf '%s\\n' 'url: http://127.0.0.1:5173/#lanes';;
  *" screenshot "*)
    printf '%s' 'png' > "$last"
    printf '%s\\n' 'saved screenshot'
    ;;
  *" open "*) printf '%s\\n' 'opened';;
  *) printf '%s\\n' 'ok';;
esac
`,
    "utf8"
  );
  writeFileSync(
    sidecarCli,
    `#!/bin/sh
set -eu
recording=""
qa=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --recording) recording="$2"; shift 2;;
    --gemini-qa) qa="$2"; shift 2;;
    *) shift;;
  esac
done
printf '%s' 'mp4' > "$recording"
cat > "$qa" <<EOF
{"provider":"gemini","kind":"gemini_video_qa","status":"passed","verdict":"pass","completion_gate_alignment":"aligned","completion_gate_matches":true,"video_artifact_uri":"$recording"}
EOF
printf '%s\\n' 'recorded'
`,
    "utf8"
  );
  chmodSync(browserUseCli, 0o755);
  chmodSync(sidecarCli, 0o755);
  process.env.AUTOMATION_OS_BROWSER_USE_CLI = browserUseCli;
  process.env.AUTOMATION_OS_BROWSER_USE_RECORDING_SIDECAR = sidecarCli;
  process.env.AUTOMATION_OS_BROWSER_USE_ARTIFACT_DIR = join(tempRoot, `${name}-artifacts`);
  return () => {
    if (previousCli === undefined) delete process.env.AUTOMATION_OS_BROWSER_USE_CLI;
    else process.env.AUTOMATION_OS_BROWSER_USE_CLI = previousCli;
    if (previousSidecar === undefined) delete process.env.AUTOMATION_OS_BROWSER_USE_RECORDING_SIDECAR;
    else process.env.AUTOMATION_OS_BROWSER_USE_RECORDING_SIDECAR = previousSidecar;
    if (previousArtifactDir === undefined) delete process.env.AUTOMATION_OS_BROWSER_USE_ARTIFACT_DIR;
    else process.env.AUTOMATION_OS_BROWSER_USE_ARTIFACT_DIR = previousArtifactDir;
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function installSlowBrowserUseFakeCli(name: string, delayMs: number): () => void {
  const previousCli = process.env.AUTOMATION_OS_BROWSER_USE_CLI;
  const previousArtifactDir = process.env.AUTOMATION_OS_BROWSER_USE_ARTIFACT_DIR;
  const screenshot = join(tempRoot, `${name}-screen.png`);
  const browserUseCli = join(tempRoot, `${name}.sh`);
  writeFileSync(
    browserUseCli,
    `#!/bin/sh
set -eu
sleep ${delayMs / 1000}
last=""
for arg in "$@"; do last="$arg"; done
case " $* " in
  *" state "*) printf '%s\\n' 'url: http://127.0.0.1:5173/#sources';;
  *" screenshot "*) printf '%s' 'png' > "$last"; printf '%s\\n' 'saved screenshot' '### Result' '- [Screenshot of viewport](${screenshot})';;
  *" open "*) printf '%s\\n' 'opened';;
  *" close "*) printf '%s\\n' 'closed';;
  *) printf '%s\\n' 'ok';;
esac
`,
    "utf8"
  );
  chmodSync(browserUseCli, 0o755);
  process.env.AUTOMATION_OS_BROWSER_USE_CLI = browserUseCli;
  process.env.AUTOMATION_OS_BROWSER_USE_ARTIFACT_DIR = join(tempRoot, `${name}-artifacts`);
  return () => {
    if (previousCli === undefined) delete process.env.AUTOMATION_OS_BROWSER_USE_CLI;
    else process.env.AUTOMATION_OS_BROWSER_USE_CLI = previousCli;
    if (previousArtifactDir === undefined) delete process.env.AUTOMATION_OS_BROWSER_USE_ARTIFACT_DIR;
    else process.env.AUTOMATION_OS_BROWSER_USE_ARTIFACT_DIR = previousArtifactDir;
  };
}

function installSlowPlaywrightFakeCli(name: string, delayMs: number): () => void {
  const previousCli = process.env.AUTOMATION_OS_PLAYWRIGHT_CLI;
  const outputRoot = join(tempRoot, `${name}-playwright-artifacts`);
  const screenshot = join(outputRoot, "screen.png");
  const consoleLog = join(outputRoot, "console.log");
  const playwrightCli = join(tempRoot, `${name}.sh`);
  writeFileSync(
    playwrightCli,
    `#!/bin/sh
set -eu
sleep ${delayMs / 1000}
mkdir -p ${JSON.stringify(outputRoot)}
case " $* " in
  *" snapshot "*) printf '%s\\n' 'Automation OS local screen snapshot';;
  *" screenshot "*) printf '%s' 'png' > ${JSON.stringify(screenshot)}; printf '%s\\n' '[Screenshot](${screenshot})';;
  *" console "*) : > ${JSON.stringify(consoleLog)}; printf '%s\\n' '[Console](${consoleLog})';;
  *" open "*) printf '%s\\n' 'opened';;
  *" resize "*) printf '%s\\n' 'resized';;
  *" session-stop "*) printf '%s\\n' 'stopped';;
  *) printf '%s\\n' 'ok';;
esac
`,
    "utf8"
  );
  chmodSync(playwrightCli, 0o755);
  process.env.AUTOMATION_OS_PLAYWRIGHT_CLI = playwrightCli;
  return () => {
    if (previousCli === undefined) delete process.env.AUTOMATION_OS_PLAYWRIGHT_CLI;
    else process.env.AUTOMATION_OS_PLAYWRIGHT_CLI = previousCli;
  };
}

function insertBrowserUseLane(input: { id: string; runId: string; cdpPort: number; profile: string; session: string; updatedAt: string }) {
  db.insert("lanes", {
    id: input.id,
    run_id: input.runId,
    role: "browser",
    cdp_port: input.cdpPort,
    profile_dir: input.profile,
    workdir: `/tmp/workdir-${input.id}`,
    browser_use_session: input.session,
    browser_use_cdp_url: `http://127.0.0.1:${input.cdpPort}`,
    browser_use_profile: input.profile,
    profile_strategy: "cdp_profile_lane",
    lane_visibility: "visible",
    status: "active",
    current_task: "Browser Use lane check",
    progress: 50,
    health: "unknown",
    resource_locks_json: ["browser_lane"],
    updated_at: input.updatedAt
  });
}

function insertBrowserUseSystemCheck(input: {
  id: string;
  createdAt: string;
  status: "ok" | "blocked";
  cdpUrl: string;
  profile: string | null;
  geminiExactBlocker?: string | null;
  artifactValidationStatus?: "ok" | "blocked";
}) {
  const exactBlocker = input.geminiExactBlocker ?? null;
  db.insert("system_checks", {
    id: input.id,
    kind: "browser_check",
    status: input.status,
    target_url: "http://127.0.0.1:5173/#lanes",
    summary: "Browser Use CLIでローカル画面のopen/state/screenshotと録画QAを完了しました",
    artifact_uri: "file:///tmp/screenshot.png",
    created_at: input.createdAt,
    metadata_json: {
      id: input.id,
      kind: "browser_check",
      driver: "browser_use_cli",
      status: input.status,
      targetUrl: "http://127.0.0.1:5173/#lanes",
      summary: "Browser Use CLIでローカル画面のopen/state/screenshotと録画QAを完了しました",
      createdAt: input.createdAt,
      metadata: {
        driver: "browser_use_cli",
        connectionStrategy: {
          mode: "cdp_profile_lane",
          session: `session-${input.id}`,
          cdpUrl: input.cdpUrl,
          profile: input.profile
        },
        recordingQa: {
          required: true,
          status: "present",
          reason: null,
          recorderStatus: "captured",
          cdpRequired: true,
          completionVetoOnly: true
        },
        geminiVideoQa: {
          status: "present",
          artifactUri: "file:///tmp/gemini-video-qa.json",
          videoArtifactUri: "file:///tmp/recording.mp4",
          completionVetoOnly: true,
          exactBlocker
        },
        artifactValidationStatus: input.artifactValidationStatus ?? "ok"
      }
    }
  });
}

function request(method: string, path: string, payload?: Record<string, unknown>) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const body = payload ? JSON.stringify(payload) : "";
    const req = Readable.from(body ? [body] : []) as NodeJS.ReadableStream & {
      method?: string;
      url?: string;
      headers?: Record<string, string>;
    };
    req.method = method;
    req.url = path;
    req.headers = body
      ? {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body))
        }
      : {};

    const chunks: Buffer[] = [];
    const headers = new Map<string, unknown>();
    const res = {
      statusCode: 200,
      setHeader(name: string, value: unknown) {
        headers.set(name.toLowerCase(), value);
        return this;
      },
      getHeader(name: string) {
        return headers.get(name.toLowerCase());
      },
      removeHeader(name: string) {
        headers.delete(name.toLowerCase());
      },
      end(chunk?: string | Buffer) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        resolve({ status: this.statusCode, body: Buffer.concat(chunks).toString("utf8") });
        return this;
      }
    };

    (app as unknown as { handle(req: unknown, res: unknown, next: (error?: unknown) => void): void }).handle(req, res, reject);
  });
}

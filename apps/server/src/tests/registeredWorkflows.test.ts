import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-registered-workflows-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");

const db = await import("../db/client.js");
const registeredWorkflows = await import("../registeredWorkflows.js");

test("fixed registered workflows define native, skill, and lane workflow entries with source refs and runner status", () => {
  assert.deepEqual(
    registeredWorkflows.fixedRegisteredWorkflows.map((workflow) => workflow.id),
    [
      "daily-ai-research-publish-run",
      "nisenprints-daily-product-canva-printify-etsy-pinterest",
      "job-application-manager",
      "prompt-transfer-ukiyoe",
      "sns-multi-poster-ukiyoe",
      "x-authenticated-browser-lane"
    ]
  );

  const dailyAi = registeredWorkflows.fixedRegisteredWorkflows.find((workflow) => workflow.id === "daily-ai-research-publish-run");
  assert.ok(dailyAi);
  assert.equal(dailyAi.runnerStatus, "connected");
  assert.equal(dailyAi.runnerKind, "daily_ai_registered");
  assert.equal(dailyAi.startCommand.command, "Daily AI registered workflow run full flow");
  assert.equal(dailyAi.startCommand.source, "fixed_automation_os_entrypoint");
  assert.equal(dailyAi.sourceRefs[0]?.path, "/Users/nichikatanaka/.codex/automations/daily-ai-research-publish-run/automation.toml");
  assert.equal(dailyAi.sourceRefs[0]?.legacyAutomationId, "daily-ai-research-publish-run");
  assert.equal(dailyAi.provenance.approvalBoundary, "billing_purchase_payment_checkout_hard_stop");
  assert.equal(dailyAi.provenance.completionBoundary, "approved_publish_requires_readback");
  assert.equal(dailyAi.provenance.safetyContract.version, "runner_safety_contract_v1");
  assert.equal(dailyAi.provenance.safetyContract.publicKind, "billing_only_hard_stop");
  assert.equal(dailyAi.provenance.codexAppContinuousSync, false);

  const connected = registeredWorkflows.fixedRegisteredWorkflows.filter((workflow) =>
    ["nisenprints-daily-product-canva-printify-etsy-pinterest", "job-application-manager", "prompt-transfer-ukiyoe"].includes(workflow.id)
  );
  assert.deepEqual(
    connected.map((workflow) => workflow.runnerKind),
    ["nisenprints_registered", "job_submit_registered", "prompt_transfer_registered"]
  );
  assert.ok(connected.every((workflow) => workflow.runnerStatus === "connected"));

  const promptTransfer = registeredWorkflows.fixedRegisteredWorkflows.find((workflow) => workflow.id === "prompt-transfer-ukiyoe");
  const sns = registeredWorkflows.fixedRegisteredWorkflows.find((workflow) => workflow.id === "sns-multi-poster-ukiyoe");
  const xLane = registeredWorkflows.fixedRegisteredWorkflows.find((workflow) => workflow.id === "x-authenticated-browser-lane");
  assert.ok(promptTransfer);
  assert.ok(sns);
  assert.ok(xLane);
  assert.equal(promptTransfer.runnerKind, "prompt_transfer_registered");
  assert.equal(sns.runnerKind, "sns_multi_poster_registered");
  assert.equal(xLane.runnerKind, "x_authenticated_browser_lane_registered");
  assert.equal(promptTransfer.runnerStatus, "connected");
  assert.equal(sns.runnerStatus, "connected");
  assert.equal(xLane.runnerStatus, "connected");
  assert.equal(promptTransfer.startCommand.source, "skill");
  assert.equal(sns.startCommand.source, "skill");
  assert.equal(xLane.startCommand.source, "native");
  assert.equal(promptTransfer.sourceRefs[0]?.type, "skill");
  assert.equal(sns.sourceRefs[0]?.type, "skill");
  assert.equal(xLane.sourceRefs[0]?.type, "native");
  assert.equal(promptTransfer.provenance.approvalBoundary, "billing_purchase_payment_checkout_hard_stop");
  assert.equal(promptTransfer.provenance.completionBoundary, "sheets_save_requires_readback");
  assert.equal(sns.provenance.approvalBoundary, "billing_purchase_payment_checkout_hard_stop");
  assert.equal(sns.provenance.completionBoundary, "approved_external_post_or_human_input_evidence");
  assert.equal(xLane.provenance.approvalBoundary, "billing_purchase_payment_checkout_hard_stop");
  assert.equal(xLane.provenance.completionBoundary, "approved_x_action_or_callable_surface_human_input_evidence");
  assert.ok(registeredWorkflows.fixedRegisteredWorkflows.every((workflow) => workflow.provenance.safetyContract.version === "runner_safety_contract_v1"));
  assert.equal(sns.provenance.safetyContract.publicKind, "billing_only_hard_stop");
  assert.equal(xLane.provenance.safetyContract.publicKind, "billing_only_hard_stop");
});

test("refreshRegisteredWorkflows upserts fixed rows without duplicating them", () => {
  db.initDb();
  db.execSql("DELETE FROM registered_workflows;");

  const first = registeredWorkflows.refreshRegisteredWorkflows();
  assert.equal(first.length, 6);

  db.execSql(`
    UPDATE registered_workflows
    SET name='stale name',
        runner_status='stale_runner',
        source_refs_json='[]',
        provenance_json='{}'
    WHERE id='daily-ai-research-publish-run';
  `);

  const second = registeredWorkflows.refreshRegisteredWorkflows();
  const updatedRows = db.querySql<{ id: string; updated_at: string }>("SELECT id, updated_at FROM registered_workflows ORDER BY id;");
  const third = registeredWorkflows.refreshRegisteredWorkflows();
  const unchangedRows = db.querySql<{ id: string; updated_at: string }>("SELECT id, updated_at FROM registered_workflows ORDER BY id;");
  const rows = db.querySql<{
    id: string;
    name: string;
    runner_status: string;
    start_command_json: string;
    source_refs_json: string;
    provenance_json: string;
  }>("SELECT id, name, runner_status, start_command_json, source_refs_json, provenance_json FROM registered_workflows ORDER BY id;");
  const dailyAi = rows.find((row) => row.id === "daily-ai-research-publish-run");

  assert.equal(second.length, 6);
  assert.equal(third.length, 6);
  assert.equal(rows.length, 6);
  assert.deepEqual(unchangedRows, updatedRows);
  assert.ok(dailyAi);
  assert.equal(dailyAi.name, "Daily AI Research + Publish Run");
  assert.equal(dailyAi.runner_status, "connected");
  assert.deepEqual(JSON.parse(dailyAi.start_command_json), {
    command: "Daily AI registered workflow run full flow",
    source: "fixed_automation_os_entrypoint"
  });
  assert.deepEqual(JSON.parse(dailyAi.source_refs_json), [
    {
      type: "automation_toml",
      path: "/Users/nichikatanaka/.codex/automations/daily-ai-research-publish-run/automation.toml",
      legacyAutomationId: "daily-ai-research-publish-run"
    }
  ]);
  assert.deepEqual(JSON.parse(dailyAi.provenance_json), {
    source: "fixed_native_registration",
    legacyAutomationId: "daily-ai-research-publish-run",
    automationTomlPath: "/Users/nichikatanaka/.codex/automations/daily-ai-research-publish-run/automation.toml",
    safetyContract: {
      version: "runner_safety_contract_v1",
      kind: "billing_only_external_action_policy",
      publicKind: "billing_only_hard_stop",
      publicLabel: "課金停止",
      externalActionBoundary: "billing_purchase_payment_checkout_hard_stop",
      defaultHardStops: ["billing", "purchase", "payment", "checkout"],
      humanInputRequiredWithEvidence: ["captcha", "otp", "security_code", "identity_verification"],
      approvedExternalActions: ["post", "save", "send", "submit", "publish"],
      externalActionExecutedByRehearsal: false
    },
    approvalBoundary: "billing_purchase_payment_checkout_hard_stop",
    completionBoundary: "approved_publish_requires_readback",
    codexAppContinuousSync: false
  });
});

test("refreshRegisteredWorkflows backfills safety contract while preserving runtime provenance", () => {
  db.initDb();
  db.execSql("DELETE FROM registered_workflows;");
  const sns = registeredWorkflows.fixedRegisteredWorkflows.find((workflow) => workflow.id === "sns-multi-poster-ukiyoe");
  assert.ok(sns);
  const now = db.nowIso();
  db.upsert("registered_workflows", {
    id: sns.id,
    name: sns.name,
    status: sns.status,
    runner_status: sns.runnerStatus,
    runner_kind: sns.runnerKind,
    project_root: sns.projectRoot,
    start_command_json: sns.startCommand,
    schedule_json: sns.schedule,
    source_refs_json: sns.sourceRefs,
    provenance_json: {
      source: "fixed_native_registration",
      legacyAutomationId: sns.id,
      automationTomlPath: "/Users/nichikatanaka/.codex/automations/sns-multi-poster-ukiyoe/automation.toml",
      codexAppContinuousSync: false,
      skillName: "sns-multi-poster-ukiyoe",
      approvalBoundary: "billing_purchase_payment_checkout_hard_stop",
      completionBoundary: "approved_external_post_or_human_input_evidence",
      scheduler: { lastRunId: "run_existing_sns", lastDueKey: "2026-06-19T18:00" },
      scheduleControl: { paused: true }
    },
    created_at: now,
    updated_at: now
  });

  registeredWorkflows.refreshRegisteredWorkflows();
  const row = registeredWorkflows.getRegisteredWorkflow("sns-multi-poster-ukiyoe");
  assert.ok(row);
  const provenance = JSON.parse(row.provenance_json) as {
    safetyContract?: { version?: string; publicKind?: string; publicLabel?: string };
    scheduler?: { lastRunId?: string; lastDueKey?: string };
    scheduleControl?: { paused?: boolean };
  };

  assert.equal(provenance.safetyContract?.version, "runner_safety_contract_v1");
  assert.equal(provenance.safetyContract?.publicKind, "billing_only_hard_stop");
  assert.equal(provenance.safetyContract?.publicLabel, "課金停止");
  assert.equal(provenance.scheduler?.lastRunId, "run_existing_sns");
  assert.equal(provenance.scheduler?.lastDueKey, "2026-06-19T18:00");
  assert.equal(provenance.scheduleControl?.paused, true);
});

test("refreshRegisteredWorkflows preserves research plan registered rows", () => {
  db.initDb();
  db.execSql("DELETE FROM registered_workflows;");
  const now = db.nowIso();

  db.upsert("registered_workflows", {
    id: "research-plan-custom",
    name: "Custom research plan",
    status: "active",
    runner_status: "connected",
    runner_kind: "research_plan_registered",
    project_root: "/Users/nichikatanaka/Documents/Codex/automation-os",
    start_command_json: { command: "custom command", source: "research_plan", researchPlanId: "research_plan_custom", visibleFlow: ["確認"] },
    schedule_json: { kind: "cron", rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0", timezone: "Asia/Taipei", label: "毎日 09:00" },
    source_refs_json: [{ type: "research_plan", path: "research_plans:research_plan_custom", researchPlanId: "research_plan_custom" }],
    provenance_json: { source: "research_plan_regularized", researchPlanId: "research_plan_custom", codexAppContinuousSync: true },
    created_at: now,
    updated_at: now
  });

  const workflows = registeredWorkflows.refreshRegisteredWorkflows();
  const custom = workflows.find((workflow) => workflow.id === "research-plan-custom");

  assert.equal(workflows.length, 7);
  assert.ok(custom);
  assert.equal(custom.runner_kind, "research_plan_registered");
  assert.equal(JSON.parse(custom.start_command_json).command, "custom command");
});

test("schedule override is runtime provenance and survives fixed definition refresh", () => {
  db.initDb();
  db.execSql("DELETE FROM registered_workflows;");

  registeredWorkflows.refreshRegisteredWorkflows();
  const before = db.querySql<{ schedule_json: string }>("SELECT schedule_json FROM registered_workflows WHERE id='daily-ai-research-publish-run';")[0];
  const updated = registeredWorkflows.setRegisteredWorkflowScheduleOverride("daily-ai-research-publish-run", {
    frequency: "weekly",
    time: "07:45",
    days: ["MO", "FR"]
  });
  assert.ok(updated);
  assert.deepEqual(registeredWorkflows.getRegisteredWorkflowEffectiveSchedule(updated), {
    rrule: "FREQ=WEEKLY;BYHOUR=7;BYMINUTE=45;BYSECOND=0;BYDAY=MO,FR",
    label: "毎週 07:45 月金"
  });

  registeredWorkflows.refreshRegisteredWorkflows();
  const after = registeredWorkflows.getRegisteredWorkflow("daily-ai-research-publish-run");
  assert.ok(after);
  const provenance = JSON.parse(after.provenance_json) as { scheduleControl?: { scheduleOverride?: { frequency?: string; time?: string; days?: string[] } } };

  assert.equal(after.schedule_json, before.schedule_json);
  assert.equal(provenance.scheduleControl?.scheduleOverride?.frequency, "weekly");
  assert.equal(provenance.scheduleControl?.scheduleOverride?.time, "07:45");
  assert.deepEqual(provenance.scheduleControl?.scheduleOverride?.days, ["MO", "FR"]);
  assert.equal(registeredWorkflows.getRegisteredWorkflowEffectiveSchedule(after).label, "毎週 07:45 月金");
});

test("initRegisteredWorkflows repairs partial stale fixed native registration without touching matching rows", () => {
  db.initDb();
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

  const workflows = registeredWorkflows.initRegisteredWorkflows();
  const rows = db.querySql<{
    id: string;
    name: string;
    runner_status: string;
    runner_kind: string;
    project_root: string;
    start_command_json: string;
    created_at: string;
    updated_at: string;
  }>("SELECT id, name, runner_status, runner_kind, project_root, start_command_json, created_at, updated_at FROM registered_workflows ORDER BY id;");
  const dailyAi = rows.find((row) => row.id === "daily-ai-research-publish-run");
  const firstUpdatedAt = rows.map((row) => ({ id: row.id, updated_at: row.updated_at }));

  assert.equal(workflows.length, 6);
  assert.equal(rows.length, 6);
  assert.ok(dailyAi);
  assert.equal(dailyAi.name, "Daily AI Research + Publish Run");
  assert.equal(dailyAi.runner_status, "connected");
  assert.equal(dailyAi.runner_kind, "daily_ai_registered");
  assert.equal(dailyAi.project_root, "/Users/nichikatanaka/Documents/New project");
  assert.deepEqual(JSON.parse(dailyAi.start_command_json), {
    command: "Daily AI registered workflow run full flow",
    source: "fixed_automation_os_entrypoint"
  });
  assert.equal(dailyAi.created_at, "2026-01-01T00:00:00.000Z");
  assert.notEqual(dailyAi.updated_at, "2026-01-01T00:00:00.000Z");

  registeredWorkflows.initRegisteredWorkflows();
  assert.deepEqual(
    db.querySql<{ id: string; updated_at: string }>("SELECT id, updated_at FROM registered_workflows ORDER BY id;"),
    firstUpdatedAt
  );
});

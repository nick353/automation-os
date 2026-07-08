import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildCodexAutomationMigrationLedger } from "../codex/automationMigrationLedger.js";
import type { RegisteredWorkflowRow } from "../registeredWorkflows.js";

test("automation migration ledger classifies registered, unregistered, inactive, and manual helper automations", () => {
  const root = mkdtempSync(join(tmpdir(), "automation-migration-ledger-"));
  writeAutomation(root, "registered-demo", {
    status: "ACTIVE",
    rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0"
  });
  writeAutomation(root, "unregistered-demo", {
    status: "ACTIVE",
    rrule: "FREQ=DAILY;BYHOUR=10;BYMINUTE=0;BYSECOND=0"
  });
  writeAutomation(root, "inactive-demo", {
    status: "INACTIVE",
    rrule: "FREQ=DAILY;BYHOUR=11;BYMINUTE=0;BYSECOND=0"
  });
  writeAutomation(root, "manual-helper-demo", {
    status: "ACTIVE",
    rrule: ""
  });
  writeAutomation(root, "automation-child-launcher-bridge", {
    kind: "heartbeat",
    status: "ACTIVE",
    rrule: "FREQ=MINUTELY;INTERVAL=5",
    prompt: "Act as the app-side child launcher, ingest, and repair bridge."
  });

  const ledger = buildCodexAutomationMigrationLedger({
    automationRoot: root,
    registeredWorkflows: [registeredWorkflow("registered-demo")]
  });
  const statuses = Object.fromEntries(ledger.items.map((item) => [item.id, item.status]));

  assert.equal(ledger.summary.total, 5);
  assert.equal(ledger.summary.registered, 1);
  assert.equal(ledger.summary.unregistered, 1);
  assert.equal(ledger.summary.inactive, 1);
  assert.equal(ledger.summary.manual_helper, 2);
  assert.equal(ledger.summary.registeredWorkflowTotal, 1);
  assert.equal(ledger.summary.migrated, 1);
  assert.equal(statuses["registered-demo"], "registered");
  assert.equal(statuses["unregistered-demo"], "unregistered");
  assert.equal(statuses["inactive-demo"], "inactive");
  assert.equal(statuses["manual-helper-demo"], "manual_helper");
  assert.equal(statuses["automation-child-launcher-bridge"], "manual_helper");
});

test("active scheduled child launcher bridge is a manual helper even with an rrule", () => {
  const root = mkdtempSync(join(tmpdir(), "automation-migration-ledger-"));
  writeAutomation(root, "automation-child-launcher-bridge", {
    kind: "heartbeat",
    status: "ACTIVE",
    rrule: "FREQ=MINUTELY;INTERVAL=5"
  });

  const ledger = buildCodexAutomationMigrationLedger({ automationRoot: root, registeredWorkflows: [] });

  assert.equal(ledger.items[0]?.status, "manual_helper");
  assert.equal(ledger.summary.unregistered, 0);
  assert.equal(ledger.summary.manual_helper, 1);
});

test("active scheduled heartbeat automation with arbitrary id is a manual helper without registration", () => {
  const root = mkdtempSync(join(tmpdir(), "automation-migration-ledger-"));
  writeAutomation(root, "arbitrary-heartbeat-helper", {
    kind: "heartbeat",
    status: "ACTIVE",
    rrule: "FREQ=MINUTELY;INTERVAL=10"
  });

  const ledger = buildCodexAutomationMigrationLedger({ automationRoot: root, registeredWorkflows: [] });

  assert.equal(ledger.items[0]?.status, "manual_helper");
  assert.equal(ledger.summary.unregistered, 0);
  assert.equal(ledger.summary.manual_helper, 1);
});

test("active cron automation is not a manual helper only because its prompt mentions bridge", () => {
  const root = mkdtempSync(join(tmpdir(), "automation-migration-ledger-"));
  writeAutomation(root, "real-bridge-workflow", {
    kind: "cron",
    status: "ACTIVE",
    rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
    prompt: "Bridge data from one system to another."
  });

  const ledger = buildCodexAutomationMigrationLedger({ automationRoot: root, registeredWorkflows: [] });

  assert.equal(ledger.items[0]?.status, "unregistered");
});

test("registered workflow match wins before manual helper classification", () => {
  const root = mkdtempSync(join(tmpdir(), "automation-migration-ledger-"));
  writeAutomation(root, "automation-child-launcher-bridge", {
    kind: "heartbeat",
    status: "ACTIVE",
    rrule: "FREQ=MINUTELY;INTERVAL=5"
  });

  const ledger = buildCodexAutomationMigrationLedger({
    automationRoot: root,
    registeredWorkflows: [registeredWorkflow("automation-child-launcher-bridge")]
  });

  assert.equal(ledger.items[0]?.status, "registered");
  assert.equal(ledger.items[0]?.automationOsMigrated, true);
});

test("ledger includes active registered workflows without automation.toml and confirms only completed runs", () => {
  const root = mkdtempSync(join(tmpdir(), "automation-migration-ledger-"));
  const workflow = registeredWorkflow("registered-only-demo", {
    runner_kind: "daily_ai_registered",
    start_command_json: JSON.stringify({ command: "Registered only demo full flow" }),
    provenance_json: JSON.stringify({
      source: "test",
      scheduler: { lastRunId: "run_registered_only_done" }
    })
  });
  const ledger = buildCodexAutomationMigrationLedger({
    automationRoot: root,
    registeredWorkflows: [workflow],
    runs: [
      runRow("run_registered_only_pending", "partial", {
        plan: { tasks: [{ adapter: "daily_ai_registered" }] },
        proof_gate: { ok: false, missing: ["full_flow_completion"], present: ["worker_receipt"] },
        blocker: "daily_ai_waiting_for_completion"
      }),
      runRow("run_registered_only_done", "complete", {
        plan: { tasks: [{ adapter: "daily_ai_registered" }] },
        proof_gate: { ok: true, missing: [], present: ["daily_ai_publish", "gemini_video_qa"] }
      }, "Registered only demo full flow")
    ],
    proofs: [
      {
        run_id: "run_registered_only_done",
        proof_type: "daily_ai_publish",
        created_at: "2026-01-02T00:00:01.000Z",
        metadata_json: "{}"
      }
    ]
  });
  const item = ledger.items.find((entry) => entry.id === "registered-only-demo");

  assert.ok(item);
  assert.equal(item.inventorySource, "registered_workflow");
  assert.equal(item.automationOsMigrated, true);
  assert.equal(item.scheduledOperationConfirmed, true);
  assert.equal(item.actualOperationConfirmed, true);
  assert.equal(item.proofConfirmed, true);
  assert.equal(item.latestRunId, "run_registered_only_done");
  assert.equal(item.latestRunStatus, "complete");
  assert.deepEqual(item.missingProofs, []);
  assert.equal(item.remainingBlocker, null);
  assert.ok(item.latestProofTypes.includes("daily_ai_publish"));
  assert.equal(ledger.summary.registered, 1);
  assert.equal(ledger.summary.scheduledConfirmed, 1);
  assert.equal(ledger.summary.actualConfirmed, 1);
  assert.equal(ledger.summary.proofConfirmed, 1);
});

test("completed registered run remains current when a later cancelled run exists", () => {
  const root = mkdtempSync(join(tmpdir(), "automation-migration-ledger-"));
  const workflow = registeredWorkflow("job-application-follow-up-inbox-2", {
    runner_kind: "job_followup_registered",
    start_command_json: JSON.stringify({ command: "Job Application Post-Application Manager registered workflow billing-only send follow-up" })
  });
  const ledger = buildCodexAutomationMigrationLedger({
    automationRoot: root,
    registeredWorkflows: [workflow],
    runs: [
      runRow(
        "run_job_followup_complete",
        "complete",
        {
          registered_workflow_id: "job-application-follow-up-inbox-2",
          plan: { tasks: [{ adapter: "job_followup_registered" }] },
          proof_gate: { ok: true, missing: [], present: ["job_followup_registered_codex_execution"] }
        },
        "Job Application Post-Application Manager registered workflow billing-only send follow-up",
        "2026-06-20T06:54:38.410Z"
      ),
      runRow(
        "run_job_followup_cancelled",
        "cancelled",
        {
          registered_workflow_id: "job-application-follow-up-inbox-2",
          stop_reason: "approval_cancelled",
          plan: { tasks: [{ adapter: "job_followup_registered" }] }
        },
        "Job Application Post-Application Manager registered workflow billing-only send follow-up",
        "2026-06-20T06:55:42.092Z"
      )
    ],
    proofs: [
      {
        run_id: "run_job_followup_complete",
        proof_type: "job_followup_registered_codex_execution",
        created_at: "2026-06-20T06:54:38.395Z",
        metadata_json: "{}"
      }
    ]
  });
  const item = ledger.items.find((entry) => entry.id === "job-application-follow-up-inbox-2");

  assert.ok(item);
  assert.equal(item.latestRunId, "run_job_followup_complete");
  assert.equal(item.latestRunStatus, "complete");
  assert.equal(item.remainingBlocker, null);
  assert.equal(item.actualOperationConfirmed, true);
  assert.equal(item.proofConfirmed, true);
});

test("unified Job manager ledger matches legacy split workflow ids", () => {
  const root = mkdtempSync(join(tmpdir(), "automation-migration-ledger-"));
  const workflow = registeredWorkflow("job-application-manager", {
    name: "Job Application Manager",
    runner_kind: "job_submit_registered",
    start_command_json: JSON.stringify({ command: "Job Application Manager registered workflow billing-only inbox readback and submit" })
  });
  const ledger = buildCodexAutomationMigrationLedger({
    automationRoot: root,
    registeredWorkflows: [workflow],
    runs: [
      runRow(
        "run_legacy_job_followup",
        "blocked",
        {
          registered_workflow_id: "job-application-follow-up-inbox-2",
          plan: { tasks: [{ adapter: "job_followup_registered" }] },
          proof_gate: { ok: false, missing: ["registered_summary_present"], present: ["job_followup_registered_codex_execution_blocked"] }
        },
        "Job Application Post-Application Manager registered workflow billing-only send follow-up",
        "2026-06-20T06:54:38.410Z"
      ),
      runRow(
        "run_legacy_job_submit",
        "partial",
        {
          registeredWorkflowId: "job-application-daily-submit-queue",
          plan: { tasks: [{ adapter: "job_submit_registered" }] },
          proof_gate: { ok: false, missing: ["submitted_confirmed"], present: ["job_submit_registered_codex_execution"] }
        },
        "Job Application Daily Submit Queue registered workflow billing-only submit",
        "2026-06-20T07:54:38.410Z"
      )
    ]
  });
  const item = ledger.items.find((entry) => entry.id === "job-application-manager");

  assert.ok(item);
  assert.equal(item.latestRunId, "run_legacy_job_submit");
  assert.equal(item.latestRunStatus, "partial");
  assert.deepEqual(item.missingProofs, ["submitted_confirmed"]);
});

test("scheduled confirmation requires the scheduler run to complete or pass confirmation", () => {
  const root = mkdtempSync(join(tmpdir(), "automation-migration-ledger-"));
  const workflow = registeredWorkflow("blocked-scheduled-demo", {
    runner_kind: "nisenprints_registered",
    start_command_json: JSON.stringify({ command: "Blocked scheduled demo full flow" }),
    provenance_json: JSON.stringify({
      source: "test",
      scheduler: { lastRunId: "run_blocked_scheduled", exactBlocker: "browser_use_registered_runner_missing" }
    })
  });
  const ledger = buildCodexAutomationMigrationLedger({
    automationRoot: root,
    registeredWorkflows: [workflow],
    runs: [
      runRow("run_blocked_scheduled", "blocked", {
        plan: { tasks: [{ adapter: "nisenprints_registered" }] },
        proof_gate: { ok: false, missing: ["browser_use_registered_runner_missing"], present: [] },
        exact_blocker: "run_exact_blocker"
      }, "Blocked scheduled demo full flow")
    ]
  });
  const item = ledger.items.find((entry) => entry.id === "blocked-scheduled-demo");

  assert.ok(item);
  assert.equal(item.scheduledOperationConfirmed, false);
  assert.equal(item.actualOperationConfirmed, false);
  assert.equal(item.proofConfirmed, false);
  assert.equal(item.remainingBlocker, "browser_use_registered_runner_missing");
  assert.deepEqual(item.missingProofs, ["browser_use_registered_runner_missing"]);
  assert.equal(ledger.summary.blocked, 1);
});

test("protected workflow scheduler waiting approval boundary confirms scheduled operation only", () => {
  const root = mkdtempSync(join(tmpdir(), "automation-migration-ledger-"));
  const workflow = registeredWorkflow("protected-scheduled-approval", {
    runner_kind: "daily_ai_registered",
    start_command_json: JSON.stringify({ command: "Protected scheduled approval full flow" }),
    provenance_json: JSON.stringify({
      source: "test",
      scheduler: { lastRunId: "run_protected_scheduled_approval", lastDueKey: "2026-06-18T09:00" }
    })
  });
  const ledger = buildCodexAutomationMigrationLedger({
    automationRoot: root,
    registeredWorkflows: [workflow],
    runs: [
      runRow("run_protected_scheduled_approval", "waiting_approval", {
        registered_workflow_id: "protected-scheduled-approval",
        registered_workflow_start: {
          source: "scheduler",
          runnerKind: "daily_ai_registered",
          dueKey: "2026-06-18T09:00"
        },
        plan: { approvalRequired: true, tasks: [{ adapter: "daily_ai_registered" }] },
        proof_gate: { ok: false, missing: ["full_flow_completion"], present: [] }
      }, "Protected scheduled approval full flow")
    ],
    approvals: [approvalRow("approval_protected_scheduled", "run_protected_scheduled_approval", "pending")]
  });
  const item = ledger.items.find((entry) => entry.id === "protected-scheduled-approval");

  assert.ok(item);
  assert.equal(item.scheduledOperationConfirmed, true);
  assert.equal(item.actualOperationConfirmed, false);
  assert.equal(item.proofConfirmed, false);
  assert.equal(item.latestRunStatus, "waiting_approval");
  assert.deepEqual(item.missingProofs, ["full_flow_completion"]);
  assert.equal(item.remainingBlocker, null);
  assert.equal(ledger.summary.scheduledConfirmed, 1);
  assert.equal(ledger.summary.actualConfirmed, 0);
  assert.equal(ledger.summary.proofConfirmed, 0);
  assert.equal(ledger.summary.blocked, 0);
});

test("older scheduled approval boundary does not hide newer latest run missing proofs", () => {
  const root = mkdtempSync(join(tmpdir(), "automation-migration-ledger-"));
  const workflow = registeredWorkflow("stale-scheduled-approval", {
    runner_kind: "daily_ai_registered",
    start_command_json: JSON.stringify({ command: "Stale scheduled approval full flow" }),
    provenance_json: JSON.stringify({
      source: "test",
      scheduler: { lastRunId: "run_pending_stale_scheduled_approval", lastDueKey: "2026-06-18T09:00" }
    })
  });
  const ledger = buildCodexAutomationMigrationLedger({
    automationRoot: root,
    registeredWorkflows: [workflow],
    runs: [
      runRow("run_pending_stale_scheduled_approval", "waiting_approval", {
        registered_workflow_id: "stale-scheduled-approval",
        registered_workflow_start: {
          source: "scheduler",
          runnerKind: "daily_ai_registered",
          dueKey: "2026-06-18T09:00"
        },
        plan: { approvalRequired: true, tasks: [{ adapter: "daily_ai_registered" }] },
        proof_gate: { ok: false, missing: ["full_flow_completion"], present: [] }
      }, "Stale scheduled approval full flow"),
      runRow("run_newer_latest_missing_proof", "partial", {
        registered_workflow_id: "stale-scheduled-approval",
        plan: { tasks: [{ adapter: "daily_ai_registered" }] },
        proof_gate: { ok: false, missing: ["newer_completion_proof"], present: [] }
      }, "Stale scheduled approval full flow")
    ],
    approvals: [approvalRow("approval_stale_scheduled", "run_pending_stale_scheduled_approval", "pending")]
  });
  const item = ledger.items.find((entry) => entry.id === "stale-scheduled-approval");

  assert.ok(item);
  assert.equal(item.scheduledOperationConfirmed, true);
  assert.equal(item.latestRunId, "run_newer_latest_missing_proof");
  assert.deepEqual(item.missingProofs, ["newer_completion_proof"]);
  assert.equal(item.remainingBlocker, "missing_proofs:newer_completion_proof");
  assert.equal(ledger.summary.blocked, 1);
});

test("protected workflow scheduler waiting approval boundary requires scheduler source due key and same pending approval", () => {
  const root = mkdtempSync(join(tmpdir(), "automation-migration-ledger-"));
  const ledger = buildCodexAutomationMigrationLedger({
    automationRoot: root,
    registeredWorkflows: [
      registeredWorkflow("missing-pending-approval", {
        runner_kind: "daily_ai_registered",
        start_command_json: JSON.stringify({ command: "Missing pending approval full flow" }),
        provenance_json: JSON.stringify({ scheduler: { lastRunId: "run_missing_pending_approval" } })
      }),
      registeredWorkflow("manual-source-approval", {
        runner_kind: "daily_ai_registered",
        start_command_json: JSON.stringify({ command: "Manual source approval full flow" }),
        provenance_json: JSON.stringify({ scheduler: { lastRunId: "run_manual_source_approval" } })
      }),
      registeredWorkflow("missing-due-key-approval", {
        runner_kind: "daily_ai_registered",
        start_command_json: JSON.stringify({ command: "Missing due key approval full flow" }),
        provenance_json: JSON.stringify({ scheduler: { lastRunId: "run_missing_due_key_approval" } })
      })
    ],
    runs: [
      runRow("run_missing_pending_approval", "waiting_approval", {
        registered_workflow_id: "missing-pending-approval",
        registered_workflow_start: { source: "scheduler", dueKey: "2026-06-18T09:00" },
        plan: { approvalRequired: true, tasks: [{ adapter: "daily_ai_registered" }] },
        proof_gate: { ok: false, missing: ["full_flow_completion"], present: [] }
      }, "Missing pending approval full flow"),
      runRow("run_manual_source_approval", "waiting_approval", {
        registered_workflow_id: "manual-source-approval",
        registered_workflow_start: { source: "manual", dueKey: "2026-06-18T09:00" },
        plan: { approvalRequired: true, tasks: [{ adapter: "daily_ai_registered" }] },
        proof_gate: { ok: false, missing: ["full_flow_completion"], present: [] }
      }, "Manual source approval full flow"),
      runRow("run_missing_due_key_approval", "waiting_approval", {
        registered_workflow_id: "missing-due-key-approval",
        registered_workflow_start: { source: "scheduler" },
        plan: { approvalRequired: true, tasks: [{ adapter: "daily_ai_registered" }] },
        proof_gate: { ok: false, missing: ["full_flow_completion"], present: [] }
      }, "Missing due key approval full flow")
    ],
    approvals: [
      approvalRow("approval_wrong_run", "run_other", "pending"),
      approvalRow("approval_manual_source", "run_manual_source_approval", "pending"),
      approvalRow("approval_missing_due_key", "run_missing_due_key_approval", "pending")
    ]
  });

  for (const id of ["missing-pending-approval", "manual-source-approval", "missing-due-key-approval"]) {
    const item = ledger.items.find((entry) => entry.id === id);
    assert.ok(item);
    assert.equal(item.scheduledOperationConfirmed, false);
    assert.equal(item.actualOperationConfirmed, false);
    assert.equal(item.proofConfirmed, false);
    assert.equal(item.remainingBlocker, "missing_proofs:full_flow_completion");
  }
  assert.equal(ledger.summary.scheduledConfirmed, 0);
  assert.equal(ledger.summary.blocked, 3);
});

test("adapter-only matches do not borrow another workflow completion", () => {
  const root = mkdtempSync(join(tmpdir(), "automation-migration-ledger-"));
  const ledger = buildCodexAutomationMigrationLedger({
    automationRoot: root,
    registeredWorkflows: [
      registeredWorkflow("daily-ai-a", {
        runner_kind: "daily_ai_registered",
        start_command_json: JSON.stringify({ command: "Daily AI A full flow" })
      }),
      registeredWorkflow("daily-ai-b", {
        runner_kind: "daily_ai_registered",
        start_command_json: JSON.stringify({ command: "Daily AI B full flow" })
      })
    ],
    runs: [
      runRow("run_daily_ai_a", "complete", {
        plan: { tasks: [{ adapter: "daily_ai_registered" }] },
        proof_gate: { ok: true, missing: [], present: ["daily_ai_publish"] }
      }, "Daily AI A full flow")
    ]
  });
  const a = ledger.items.find((entry) => entry.id === "daily-ai-a");
  const b = ledger.items.find((entry) => entry.id === "daily-ai-b");

  assert.equal(a?.latestRunId, "run_daily_ai_a");
  assert.equal(a?.actualOperationConfirmed, true);
  assert.equal(b?.latestRunId, null);
  assert.equal(b?.actualOperationConfirmed, false);
});

test("scheduler lastRunId does not borrow another workflow completion", () => {
  const root = mkdtempSync(join(tmpdir(), "automation-migration-ledger-"));
  const ledger = buildCodexAutomationMigrationLedger({
    automationRoot: root,
    registeredWorkflows: [
      registeredWorkflow("scheduled-a", {
        runner_kind: "daily_ai_registered",
        start_command_json: JSON.stringify({ command: "Scheduled A full flow" }),
        provenance_json: JSON.stringify({ scheduler: { lastRunId: "run_scheduled_a" } })
      }),
      registeredWorkflow("scheduled-b", {
        runner_kind: "daily_ai_registered",
        start_command_json: JSON.stringify({ command: "Scheduled B full flow" }),
        provenance_json: JSON.stringify({ scheduler: { lastRunId: "run_scheduled_a" } })
      })
    ],
    runs: [
      runRow("run_scheduled_a", "complete", {
        plan: { tasks: [{ adapter: "daily_ai_registered" }] },
        proof_gate: { ok: true, missing: [], present: ["daily_ai_publish"] }
      }, "Scheduled A full flow")
    ]
  });
  const a = ledger.items.find((entry) => entry.id === "scheduled-a");
  const b = ledger.items.find((entry) => entry.id === "scheduled-b");

  assert.equal(a?.scheduledOperationConfirmed, true);
  assert.equal(b?.scheduledOperationConfirmed, false);
});

test("direct workflow id mismatch blocks fallback matching", () => {
  const root = mkdtempSync(join(tmpdir(), "automation-migration-ledger-"));
  const ledger = buildCodexAutomationMigrationLedger({
    automationRoot: root,
    registeredWorkflows: [
      registeredWorkflow("direct-a", {
        runner_kind: "daily_ai_registered",
        start_command_json: JSON.stringify({ command: "Direct A full flow" })
      }),
      registeredWorkflow("direct-b", {
        runner_kind: "daily_ai_registered",
        start_command_json: JSON.stringify({ command: "Direct A full flow" })
      })
    ],
    runs: [
      runRow("run_direct_a", "complete", {
        registered_workflow_id: "direct-a",
        plan: { tasks: [{ adapter: "daily_ai_registered" }] },
        proof_gate: { ok: true, missing: [], present: ["daily_ai_publish"] }
      }, "Direct A full flow")
    ]
  });
  const a = ledger.items.find((entry) => entry.id === "direct-a");
  const b = ledger.items.find((entry) => entry.id === "direct-b");

  assert.equal(a?.latestRunId, "run_direct_a");
  assert.equal(b?.latestRunId, null);
});

test("new registered workflow runner kinds participate in registered-only evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "automation-migration-ledger-"));
  const workflow = registeredWorkflow("prompt-transfer-ukiyoe", {
    name: "Prompt Transfer Ukiyoe",
    runner_kind: "prompt_transfer_registered",
    start_command_json: JSON.stringify({ command: "Prompt Transfer Ukiyoe registered workflow billing-only save sheets" }),
    provenance_json: JSON.stringify({
      source: "fixed_native_registration",
      scheduler: { lastRunId: "run_prompt_transfer_waiting", lastDueKey: "2026-06-18T07:45" }
    })
  });
  const ledger = buildCodexAutomationMigrationLedger({
    automationRoot: root,
    registeredWorkflows: [workflow],
    runs: [
      runRow("run_prompt_transfer_waiting", "waiting_approval", {
        registered_workflow_id: "prompt-transfer-ukiyoe",
        registered_workflow_start: {
          source: "scheduler",
          runnerKind: "prompt_transfer_registered",
          dueKey: "2026-06-18T07:45"
        },
        plan: { approvalRequired: true, tasks: [{ adapter: "prompt_transfer_registered" }] },
        proof_gate: { ok: false, missing: ["approved_external_write_runner_proof"], present: [] }
      }, "Prompt Transfer Ukiyoe registered workflow billing-only save sheets")
    ],
    approvals: [approvalRow("approval_prompt_transfer", "run_prompt_transfer_waiting", "pending")]
  });
  const item = ledger.items.find((entry) => entry.id === "prompt-transfer-ukiyoe");

  assert.ok(item);
  assert.equal(item.inventorySource, "registered_workflow");
  assert.equal(item.runnerKind, "prompt_transfer_registered");
  assert.equal(item.automationOsMigrated, true);
  assert.equal(item.scheduledOperationConfirmed, true);
  assert.equal(item.actualOperationConfirmed, false);
  assert.equal(item.proofConfirmed, false);
  assert.equal(item.remainingBlocker, null);
  assert.equal(ledger.summary.scheduledConfirmed, 1);
  assert.equal(ledger.summary.blocked, 0);
});

test("text fallback requires exact workflow text match", () => {
  const root = mkdtempSync(join(tmpdir(), "automation-migration-ledger-"));
  const ledger = buildCodexAutomationMigrationLedger({
    automationRoot: root,
    registeredWorkflows: [
      registeredWorkflow("daily-ai", {
        name: "Daily AI",
        runner_kind: "daily_ai_registered",
        start_command_json: JSON.stringify({ command: "Daily AI" })
      }),
      registeredWorkflow("daily-ai-a", {
        name: "Daily AI A",
        runner_kind: "daily_ai_registered",
        start_command_json: JSON.stringify({ command: "Daily AI A" })
      })
    ],
    runs: [
      runRow("run_daily_ai_a", "complete", {
        plan: { tasks: [{ adapter: "daily_ai_registered" }] },
        proof_gate: { ok: true, missing: [], present: ["daily_ai_publish"] }
      }, "Daily AI A")
    ]
  });
  const generic = ledger.items.find((entry) => entry.id === "daily-ai");
  const specific = ledger.items.find((entry) => entry.id === "daily-ai-a");

  assert.equal(generic?.latestRunId, null);
  assert.equal(specific?.latestRunId, "run_daily_ai_a");
});

function writeAutomation(root: string, id: string, input: { status: string; rrule: string; kind?: string; prompt?: string }) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  const lines = [
    "version = 1",
    `id = "${id}"`,
    `kind = "${input.kind ?? "cron"}"`,
    `name = "${id}"`,
    `status = "${input.status}"`,
    `prompt = "${input.prompt ?? `Run ${id}.`}"`
  ];
  if (input.rrule) {
    lines.push(`rrule = "${input.rrule}"`);
  }
  writeFileSync(join(dir, "automation.toml"), `${lines.join("\n")}\n`);
}

function registeredWorkflow(id: string, overrides: Partial<RegisteredWorkflowRow> = {}): RegisteredWorkflowRow {
  return {
    id,
    name: id,
    status: "active",
    runner_status: "connected",
    runner_kind: "test_registered",
    project_root: "/tmp/project",
    start_command_json: "{}",
    schedule_json: "{}",
    source_refs_json: JSON.stringify([{ type: "automation_toml", path: `/tmp/automations/${id}/automation.toml`, legacyAutomationId: id }]),
    provenance_json: JSON.stringify({ source: "test", legacyAutomationId: id }),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function runRow(id: string, status: string, metadata: Record<string, unknown>, objective = id, updatedAt?: string) {
  const timestamp = updatedAt ?? (id.includes("pending") ? "2026-01-01T00:00:00.000Z" : "2026-01-02T00:00:00.000Z");
  return {
    id,
    name: id,
    status,
    objective,
    created_at: timestamp,
    updated_at: timestamp,
    metadata_json: JSON.stringify(metadata)
  };
}

function approvalRow(id: string, runId: string, status: string) {
  return {
    id,
    run_id: runId,
    status,
    created_at: "2026-01-02T00:00:00.000Z"
  };
}

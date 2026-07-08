import Database from "better-sqlite3";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { dbBackend, dbPath, insert, makeId, nowIso } from "../db/client.js";
import { evaluateDailyAiRegisteredSummary } from "../runs/dailyAiRegisteredRunner.js";

const defaultSummaryPath =
  "/Users/nichikatanaka/Documents/New project/artifacts/automation-os-daily-ai-runs/run_mr0bb2w6_hjorkr/registered-playwright-cli-summary.json";
const ingestReceiptPath = readArgValue("--ingest-receipt");
const summaryPath = resolve(readArgValue("--summary") ?? defaultSummaryPath);
const outDir = resolve(readArgValue("--out-dir") ?? `data/artifacts/daily-ai-research-publish-run/reconciliation-${timestamp()}`);
const commitRequested = process.argv.includes("--commit");

type RunRow = {
  id: string;
  name: string;
  status: string;
  created_at: string;
  updated_at: string;
  metadata_json: string;
};

type JsonRecord = Record<string, unknown>;

if (ingestReceiptPath) {
  runPartialIngestReconciliation(resolve(ingestReceiptPath));
} else {
  runBlockerReconciliation();
}

function runBlockerReconciliation(): void {
const summary = readJson(summaryPath);
const evaluation = evaluateDailyAiRegisteredSummary(summaryPath);
const latestDailyAiRun = readLatestDailyAiRun();
const fullFlow = recordValue(summary.full_flow_completion);
const runwayRepair = recordValue(fullFlow?.runway_mcp_repair);
const buffer = {
  ship_now_buffer_count: numberValue(fullFlow?.ship_now_buffer_count),
  usable_publish_candidate_count: numberValue(fullFlow?.usable_publish_candidate_count),
  ship_now_buffer_target: numberValue(fullFlow?.ship_now_buffer_target)
};
const failures = Array.isArray(fullFlow?.failures) ? fullFlow.failures.map(String) : [];
const explicitMissing = [
  ...evaluation.proof_gate.missing,
  ...(runwayRepair?.required === true ? ["runway_mcp_repair_required"] : []),
  ...(buffer.usable_publish_candidate_count < buffer.ship_now_buffer_target ? ["daily_ai_buffer"] : [])
];
const proofGate = {
  ok: false,
  missing: [...new Set(explicitMissing)],
  present: evaluation.proof_gate.present
};
const exactBlocker = stringValue(runwayRepair?.exact_blocker) || firstFailureMatching(failures, /runway_mcp|image_generation|buffer|ship_now/i) || evaluation.proof_summary;
const receipt = {
  ok: true,
  workflow: "daily-ai-research-publish-run",
  stage: "automation_os_daily_ai_blocker_reconciliation_receipt",
  generated_at: new Date().toISOString(),
  automation_os_db_mutated: commitRequested,
  strict_registered_success_claimed: false,
  reconciliation_status: commitRequested ? "project_owned_blocker_recorded_as_reconciliation_readback" : "project_owned_blocker_ready_for_reconciliation_readback",
  registered_workflow_id: "daily-ai-research-publish-run",
  automation_os_latest_run: latestDailyAiRun
    ? {
        id: latestDailyAiRun.id,
        status: latestDailyAiRun.status,
        created_at: latestDailyAiRun.created_at,
        updated_at: latestDailyAiRun.updated_at
      }
    : null,
  project_run: {
    run_id: stringValue(summary.run_id),
    summary_path: summaryPath,
    status: evaluation.status,
    proof_summary: evaluation.proof_summary,
    proof_gate: proofGate,
    exact_blocker: exactBlocker,
    external_actions_performed: false,
    additional_posts_published: false,
    posted_count: numberValue(fullFlow?.posted_count),
    engagement_sent_count: numberValue(fullFlow?.engagement_sent_count),
    sheets_synced_count: numberValue(fullFlow?.sheets_synced_count),
    feed_study_count: numberValue(fullFlow?.feed_study_count),
    buffer,
    runway_mcp_repair: runwayRepair ?? null,
    failures
  },
  next_safe_action:
    "Provide a current Daily AI Runway MCP gpt-image-2 result JSON through DAILY_AI_RUNWAY_MCP_RESULT or attach-runway-mcp-result-local, restore usable publish buffer to 3/3, then rerun the registered Playwright CLI entrypoint without reposting completed platforms.",
  stop_conditions: [
    "billing_purchase_payment_checkout",
    "captcha_otp_security_code_identity_verification",
    "account_auth_gate_or_expected_account_mismatch",
    "external_action_without_source_of_truth_and_cleanup_proof"
  ]
};

mkdirSync(outDir, { recursive: true });
const receiptPath = join(outDir, "daily-ai-blocker-reconciliation-receipt.json");
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
const committedRun = commitRequested ? commitBlockerReadback(receiptPath, receipt, latestDailyAiRun, summaryPath) : null;

console.log(
  JSON.stringify(
    {
      ok: true,
      receiptPath,
      receiptUri: pathToFileURL(receiptPath).href,
      committedRun,
      latestAutomationOsRun: receipt.automation_os_latest_run,
      projectRun: {
        run_id: receipt.project_run.run_id,
        proof_gate: receipt.project_run.proof_gate,
        exact_blocker: receipt.project_run.exact_blocker,
        buffer: receipt.project_run.buffer
      },
      nextSafeAction: receipt.next_safe_action
    },
    null,
    2
  )
);
}

function commitBlockerReadback(receiptPath: string, receipt: JsonRecord, latestDailyAiRun: RunRow | null, summaryPath: string): { runId: string; proofId: string } {
  if (!latestDailyAiRun) throw new Error("automation_os_latest_daily_ai_run_missing");
  const projectRun = recordValue(receipt.project_run) ?? {};
  const runId = makeId("run_daily_ai_reconcile");
  const stepId = `${runId}_step_1`;
  const proofId = makeId("proof_daily_ai_reconcile");
  const eventId = makeId("evt_daily_ai_reconcile");
  const now = nowIso();
  const proofType = "daily_ai_blocker_reconciliation_readback";
  const metadata = {
    registeredWorkflowId: "daily-ai-research-publish-run",
    registered_workflow_id: "daily-ai-research-publish-run",
    reconciliation_run: true,
    reconciliation_of_run_id: latestDailyAiRun.id,
    project_run_id: stringValue(projectRun.run_id),
    project_summary_path: summaryPath,
    exact_blocker: stringValue(projectRun.exact_blocker),
    external_actions_performed: false,
    additional_posts_published: false,
    strict_registered_success_claimed: false,
    proof_gate: projectRun.proof_gate,
    proof_summary: `blocked: ${stringValue(projectRun.exact_blocker)}`,
    buffer: projectRun.buffer,
    runway_mcp_repair: projectRun.runway_mcp_repair
  };
  insert("runs", {
    id: runId,
    name: "Daily AI blocker reconciliation readback",
    status: "blocked",
    objective: "Record project-owned Daily AI blocker as Automation OS reconciliation readback without posting",
    created_at: now,
    updated_at: now,
    metadata_json: metadata
  });
  insert("run_steps", {
    id: stepId,
    run_id: runId,
    name: "Record Daily AI blocker reconciliation readback",
    status: "blocked",
    lane_id: null,
    started_at: now,
    completed_at: now,
    metadata_json: {
      adapter: "daily_ai_blocker_reconciliation_readback",
      requires_approval: false,
      dangerous_action: false,
      external_actions_performed: false,
      additional_posts_published: false,
      proof_gate: projectRun.proof_gate,
      proof_summary: metadata.proof_summary
    }
  });
  insert("proofs", {
    id: proofId,
    run_id: runId,
    step_id: stepId,
    proof_type: proofType,
    label: "Daily AI blocker reconciliation readback",
    uri: pathToFileURL(receiptPath).href,
    size_bytes: Buffer.byteLength(readFileSync(receiptPath)),
    created_at: now,
    metadata_json: metadata
  });
  insert("worker_events", {
    id: eventId,
    run_id: runId,
    step_id: stepId,
    lane_id: null,
    event_type: "worker_blocked",
    message: metadata.proof_summary,
    created_at: now,
    metadata_json: metadata
  });
  return { runId, proofId };
}

function runPartialIngestReconciliation(sourceReceiptPath: string): void {
  const ingestReceipt = readJson(sourceReceiptPath);
  const latestDailyAiRun = readLatestDailyAiRun();
  const terminalState = recordValue(ingestReceipt.terminal_state);
  const queueReadback = recordValue(ingestReceipt.queue_readback);
  const externalActionSummary = recordValue(ingestReceipt.external_action_summary);
  const bufferAfterStop = recordValue(queueReadback?.buffer_after_stop);
  const sheetsSyncedCount = numberValue(terminalState?.sheets_synced_count);
  const proofGate = {
    ok: false,
    missing: [
      "user_interrupted_after_linkedin_publish",
      "daily_ai_feed_study",
      "daily_ai_engagement",
      ...(sheetsSyncedCount > 0 ? [] : ["daily_ai_sync"]),
      "daily_ai_buffer",
      "daily_ai_cleanup"
    ],
    present: ["daily_ai_publish", ...(sheetsSyncedCount > 0 ? ["daily_ai_sync"] : []), "daily_ai_registered_summary"]
  };
  const exactBlocker =
    stringValue(ingestReceipt.remaining_blocker) ||
    "user_interrupted_after_linkedin_publish:signal_SIGTERM; full_flow_incomplete";
  const receipt = {
    ok: true,
    workflow: "daily-ai-research-publish-run",
    stage: "automation_os_daily_ai_fresh_child_partial_ingest_reconciliation_receipt",
    generated_at: new Date().toISOString(),
    automation_os_db_mutated: commitRequested,
    strict_registered_success_claimed: false,
    reconciliation_status: commitRequested ? "fresh_child_partial_ingest_recorded_as_reconciliation_readback" : "fresh_child_partial_ingest_ready_for_reconciliation_readback",
    registered_workflow_id: "daily-ai-research-publish-run",
    automation_os_latest_run: latestDailyAiRun
      ? {
          id: latestDailyAiRun.id,
          status: latestDailyAiRun.status,
          created_at: latestDailyAiRun.created_at,
          updated_at: latestDailyAiRun.updated_at
        }
      : null,
    project_run: {
      run_id: stringValue(ingestReceipt.run_id),
      child_thread_id: stringValue(ingestReceipt.child_thread_id),
      child_status: stringValue(ingestReceipt.child_status),
      summary_path: stringValue(ingestReceipt.run_summary),
      status: "partial",
      proof_summary: `partial: ${exactBlocker}`,
      proof_gate: proofGate,
      exact_blocker: exactBlocker,
      parent_external_action_performed: ingestReceipt.parent_external_action_performed === true,
      child_external_action_observed: ingestReceipt.child_external_action_observed === true,
      external_actions_performed: false,
      additional_posts_published: false,
      external_action_summary: externalActionSummary ?? null,
      terminal_state: terminalState ?? null,
      queue_readback: queueReadback ?? null,
      posted_count: numberValue(terminalState?.posted_count),
      engagement_sent_count: numberValue(terminalState?.engagement_sent_count),
      sheets_synced_count: sheetsSyncedCount,
      feed_study_count: numberValue(terminalState?.feed_study_count),
      buffer: {
        ship_now_buffer_count: numberValue(bufferAfterStop?.ship_now_buffer_count),
        usable_publish_candidate_count: numberValue(bufferAfterStop?.usable_publish_candidate_count),
        ship_now_buffer_target: 3
      },
      source_ingest_receipt_path: sourceReceiptPath
    },
    next_safe_action:
      "Do not auto-resume external publish/engagement after the user's interruption. Continue only with non-posting repair/readback or explicit current approval; preserve existing X and LinkedIn URLs.",
    stop_conditions: [
      "user_questioned_or_rejected_runner_start",
      "billing_purchase_payment_checkout",
      "captcha_otp_security_code_identity_verification",
      "duplicate_repost_risk_without_url_readback",
      "external_publish_without_explicit_current_confirmation_after_interruption"
    ]
  };

  mkdirSync(outDir, { recursive: true });
  const receiptPath = join(outDir, "daily-ai-fresh-child-partial-ingest-reconciliation-receipt.json");
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  const committedRun = commitRequested ? commitPartialIngestReadback(receiptPath, receipt) : null;

  console.log(
    JSON.stringify(
      {
        ok: true,
        receiptPath,
        receiptUri: pathToFileURL(receiptPath).href,
        committedRun,
        latestAutomationOsRun: receipt.automation_os_latest_run,
        projectRun: {
          run_id: receipt.project_run.run_id,
          proof_gate: receipt.project_run.proof_gate,
          exact_blocker: receipt.project_run.exact_blocker,
          buffer: receipt.project_run.buffer,
          child_external_action_observed: receipt.project_run.child_external_action_observed,
          external_action_summary: receipt.project_run.external_action_summary
        },
        nextSafeAction: receipt.next_safe_action
      },
      null,
      2
    )
  );
}

function commitPartialIngestReadback(receiptPath: string, receipt: JsonRecord): { runId: string; proofId: string } {
  const latestDailyAiRun = readLatestDailyAiRun();
  if (!latestDailyAiRun) throw new Error("automation_os_latest_daily_ai_run_missing");
  const runId = makeId("run_daily_ai_partial_ingest");
  const stepId = `${runId}_step_1`;
  const proofId = makeId("proof_daily_ai_partial_ingest");
  const eventId = makeId("evt_daily_ai_partial_ingest");
  const now = nowIso();
  const projectRun = recordValue(receipt.project_run) ?? {};
  const metadata = {
    registeredWorkflowId: "daily-ai-research-publish-run",
    registered_workflow_id: "daily-ai-research-publish-run",
    reconciliation_run: true,
    reconciliation_kind: "fresh_child_partial_ingest",
    reconciliation_of_run_id: latestDailyAiRun.id,
    project_run_id: stringValue(projectRun.run_id),
    child_thread_id: stringValue(projectRun.child_thread_id),
    project_summary_path: stringValue(projectRun.summary_path),
    source_ingest_receipt_path: stringValue(projectRun.source_ingest_receipt_path),
    exact_blocker: stringValue(projectRun.exact_blocker),
    parent_external_action_performed: projectRun.parent_external_action_performed === true,
    child_external_action_observed: projectRun.child_external_action_observed === true,
    external_actions_performed: false,
    additional_posts_published: false,
    strict_registered_success_claimed: false,
    proof_gate: projectRun.proof_gate,
    proof_summary: stringValue(projectRun.proof_summary),
    external_action_summary: projectRun.external_action_summary ?? null,
    terminal_state: projectRun.terminal_state ?? null,
    queue_readback: projectRun.queue_readback ?? null,
    buffer: projectRun.buffer
  };
  insert("runs", {
    id: runId,
    name: "Daily AI fresh child partial ingest readback",
    status: "partial",
    objective: "Record Daily AI fresh child partial ingest without reposting or resuming external engagement",
    created_at: now,
    updated_at: now,
    metadata_json: metadata
  });
  insert("run_steps", {
    id: stepId,
    run_id: runId,
    name: "Record Daily AI fresh child partial ingest readback",
    status: "blocked",
    lane_id: null,
    started_at: now,
    completed_at: now,
    metadata_json: {
      adapter: "daily_ai_fresh_child_partial_ingest_readback",
      requires_approval: false,
      dangerous_action: false,
      external_actions_performed: false,
      additional_posts_published: false,
      child_external_action_observed: metadata.child_external_action_observed,
      proof_gate: metadata.proof_gate,
      proof_summary: metadata.proof_summary
    }
  });
  insert("proofs", {
    id: proofId,
    run_id: runId,
    step_id: stepId,
    proof_type: "daily_ai_fresh_child_partial_ingest_readback",
    label: "Daily AI fresh child partial ingest readback",
    uri: pathToFileURL(receiptPath).href,
    size_bytes: Buffer.byteLength(readFileSync(receiptPath)),
    created_at: now,
    metadata_json: metadata
  });
  insert("worker_events", {
    id: eventId,
    run_id: runId,
    step_id: stepId,
    lane_id: null,
    event_type: "worker_blocked",
    message: metadata.proof_summary,
    created_at: now,
    metadata_json: metadata
  });
  return { runId, proofId };
}

function readLatestDailyAiRun(): RunRow | null {
  if (dbBackend !== "sqlite") throw new Error("daily_ai_reconciliation_requires_local_sqlite_readback");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return (
      db
        .prepare(
          `
          SELECT id, name, status, created_at, updated_at, metadata_json
          FROM runs
          WHERE COALESCE(json_extract(metadata_json,'$.registeredWorkflowId'), json_extract(metadata_json,'$.registered_workflow_id'))='daily-ai-research-publish-run'
            AND COALESCE(json_extract(metadata_json,'$.reconciliation_run'), 0) != 1
          ORDER BY created_at DESC
          LIMIT 1;
        `
        )
        .get() as RunRow | undefined
    ) ?? null;
  } finally {
    db.close();
  }
}

function readJson(path: string): JsonRecord {
  return JSON.parse(readFileSync(path, "utf8")) as JsonRecord;
}

function readArgValue(name: string): string | undefined {
  const match = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return match?.slice(name.length + 1);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function recordValue(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function firstFailureMatching(failures: string[], pattern: RegExp): string {
  return failures.find((failure) => pattern.test(failure)) ?? "";
}

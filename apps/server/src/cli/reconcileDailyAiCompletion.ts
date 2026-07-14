import Database from "better-sqlite3";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { dbBackend, dbPath, insert, makeId, nowIso } from "../db/client.js";
import { buildCanonicalExecutionRoutingMetadataForCommand } from "../codex/executionRouting.js";
import { evaluateDailyAiRegisteredSummary } from "../runs/dailyAiRegisteredRunner.js";

const defaultSummaryPath =
  "/Users/nichikatanaka/Documents/New project/artifacts/playwright-cli-runs/2026-07-02T13-41-45-654Z/registered-playwright-cli-summary.json";
const summaryPath = resolve(readArgValue("--summary") ?? defaultSummaryPath);
const outDir = resolve(readArgValue("--out-dir") ?? `data/artifacts/daily-ai-research-publish-run/completion-reconciliation-${timestamp()}`);
const commitRequested = process.argv.includes("--commit");
const proofType = "daily_ai_completion_reconciliation_readback";

type RunRow = {
  id: string;
  name: string;
  status: string;
  created_at: string;
  updated_at: string;
  metadata_json: string;
};

type JsonRecord = Record<string, unknown>;

const summary = readJson(summaryPath);
const evaluation = evaluateDailyAiRegisteredSummary(summaryPath);
const latestDailyAiRun = readLatestDailyAiRun();
const fullFlow = recordValue(summary.full_flow_completion);
const proofGate = {
  ok: evaluation.status === "complete" && evaluation.proof_gate.ok,
  missing: evaluation.status === "complete" ? [] : evaluation.proof_gate.missing,
  present: [...new Set([...evaluation.proof_gate.present, proofType])]
};
const ok = evaluation.status === "complete" && proofGate.ok;
const routeMetadata = buildCanonicalExecutionRoutingMetadataForCommand({
  command: "Record project-owned Daily AI completion proof as Automation OS reconciliation readback without posting",
  source: "manual",
  selectedAdapter: "daily_ai_completion_reconciliation_readback"
});
const receipt = {
  ok,
  workflow: "daily-ai-research-publish-run",
  stage: "automation_os_daily_ai_completion_reconciliation_receipt",
  generated_at: new Date().toISOString(),
  automation_os_db_mutated: commitRequested && ok,
  strict_registered_success_claimed: false,
  reconciliation_status: ok
    ? commitRequested
      ? "project_owned_completion_recorded_as_reconciliation_readback"
      : "project_owned_completion_ready_for_reconciliation_readback"
    : "blocked",
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
    automation_os_run_id: stringValue(summary.automation_os_run_id),
    external_actions_performed: false,
    additional_posts_published: false,
    posted_count: numberValue(fullFlow?.posted_count),
    engagement_sent_count: numberValue(fullFlow?.engagement_sent_count),
    required_engagement_action_count: numberValue(fullFlow?.required_engagement_action_count),
    sheets_synced_count: numberValue(fullFlow?.sheets_synced_count),
    feed_study_count: numberValue(fullFlow?.feed_study_count),
    feed_study_stop_reason: stringValue(fullFlow?.feed_study_stop_reason),
    verified_external_engagement_targets_complete: fullFlow?.verified_external_engagement_targets_complete === true,
    verified_engagement_covers_no_published_feed_study: fullFlow?.verified_engagement_covers_no_published_feed_study === true,
    buffer: {
      ship_now_buffer_count: numberValue(fullFlow?.ship_now_buffer_count),
      usable_publish_candidate_count: numberValue(fullFlow?.usable_publish_candidate_count),
      ship_now_buffer_target: numberValue(fullFlow?.ship_now_buffer_target)
    },
    failures: Array.isArray(fullFlow?.failures) ? fullFlow.failures.map(String) : []
  },
  checks: [
    {
      name: "daily_ai_summary_evaluates_complete",
      ok: evaluation.status === "complete",
      detail: evaluation.proof_summary
    },
    {
      name: "proof_gate_ok",
      ok: evaluation.proof_gate.ok === true,
      detail: `missing=${evaluation.proof_gate.missing.length}`
    },
    {
      name: "strict_runner_success_not_claimed",
      ok: stringValue(summary.automation_os_run_id) === "",
      detail: "automation_os_run_id is empty; recording completion reconciliation readback only"
    }
  ],
  next_safe_action:
    "Treat Daily AI as complete for Automation OS reconciliation readback while preserving that this is not a strict registered-runner success claim; continue G003 accounting for the remaining exact human/tooling boundaries.",
  stop_conditions: [
    "billing_purchase_payment_checkout",
    "captcha_otp_security_code_identity_verification",
    "account_auth_gate_or_expected_account_mismatch",
    "external_action_without_source_of_truth_and_cleanup_proof"
  ]
};

mkdirSync(outDir, { recursive: true });
const receiptPath = join(outDir, "daily-ai-completion-reconciliation-receipt.json");
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
const committedRun = commitRequested && ok ? commitCompletionReadback(receiptPath) : null;

console.log(
  JSON.stringify(
    {
      ok,
      receiptPath,
      receiptUri: pathToFileURL(receiptPath).href,
      committedRun,
      latestAutomationOsRun: receipt.automation_os_latest_run,
      projectRun: {
        run_id: receipt.project_run.run_id,
        proof_gate: receipt.project_run.proof_gate,
        proof_summary: receipt.project_run.proof_summary,
        posted_count: receipt.project_run.posted_count,
        engagement_sent_count: receipt.project_run.engagement_sent_count,
        sheets_synced_count: receipt.project_run.sheets_synced_count,
        buffer: receipt.project_run.buffer
      },
      nextSafeAction: receipt.next_safe_action
    },
    null,
    2
  )
);
process.exitCode = ok ? 0 : 1;

function commitCompletionReadback(receiptPath: string): { runId: string; proofId: string } {
  if (!latestDailyAiRun) throw new Error("automation_os_latest_daily_ai_run_missing");
  const runId = makeId("run_daily_ai_completion");
  const stepId = `${runId}_step_1`;
  const proofId = makeId("proof_daily_ai_completion");
  const eventId = makeId("evt_daily_ai_completion");
  const now = nowIso();
  const metadata = {
    registeredWorkflowId: "daily-ai-research-publish-run",
    registered_workflow_id: "daily-ai-research-publish-run",
    reconciliation_run: true,
    reconciliation_kind: "daily_ai_completion",
    reconciliation_of_run_id: latestDailyAiRun.id,
    project_run_id: stringValue(summary.run_id),
    project_summary_path: summaryPath,
    external_actions_performed: false,
    additional_posts_published: false,
    strict_registered_success_claimed: false,
    proof_gate: proofGate,
    proof_summary: "complete: Daily AI completion reconciliation readback recorded without additional posting",
    full_flow_completion: fullFlow ?? null,
    ...routeMetadata
  };
  insert("runs", {
    id: runId,
    name: "Daily AI completion reconciliation readback",
    status: "complete",
    objective: "Record project-owned Daily AI completion proof as Automation OS reconciliation readback without posting",
    created_at: now,
    updated_at: now,
    metadata_json: metadata
  });
  insert("run_steps", {
    id: stepId,
    run_id: runId,
    name: "Record Daily AI completion reconciliation readback",
    status: "completed",
    lane_id: null,
    started_at: now,
    completed_at: now,
    metadata_json: {
      adapter: "daily_ai_completion_reconciliation_readback",
      requires_approval: false,
      dangerous_action: false,
      external_actions_performed: false,
      additional_posts_published: false,
      proof_gate: metadata.proof_gate,
      proof_summary: metadata.proof_summary,
      ...routeMetadata
    }
  });
  insert("proofs", {
    id: proofId,
    run_id: runId,
    step_id: stepId,
    proof_type: proofType,
    label: "Daily AI completion reconciliation readback",
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
    event_type: "worker_completed",
    message: metadata.proof_summary,
    created_at: now,
    metadata_json: metadata
  });
  return { runId, proofId };
}

function readLatestDailyAiRun(): RunRow | null {
  if (dbBackend !== "sqlite") throw new Error("daily_ai_completion_reconciliation_requires_local_sqlite_readback");
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

import Database from "better-sqlite3";
import { dirname, join, resolve } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dbBackend, dbPath, insert, makeId, nowIso } from "../db/client.js";

const defaultSummaryPath =
  "/Users/nichikatanaka/Documents/Codex/automation-os/data/artifacts/prompt-transfer-ukiyoe/artifacts/runs/run_mqtbe1ep_vgi2ex/result.json";
const summaryPath = resolve(readArgValue("--summary") ?? defaultSummaryPath);
const outDir = resolve(readArgValue("--out-dir") ?? `data/artifacts/prompt-transfer-ukiyoe/reconciliation-${timestamp()}`);
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

const summary = readJson(summaryPath);
const planPath = join(dirname(summaryPath), "apply-plan", "plan.json");
const plan = readJson(planPath);
const latestPromptTransferRun = readLatestPromptTransferRun();
const exactBlocker = stringValue(summary.exact_blocker) || "prompt_transfer_blocker_unknown";
const plannedRange = plannedRangeFromPlan(plan);
const proofType = "prompt_transfer_blocker_reconciliation_readback";
const proofGate = {
  ok: false,
  missing: [exactBlocker],
  present: ["prompt_transfer_plan_ready", proofType]
};
const receipt = {
  ok: exactBlocker === "google_service_account_json_missing" && summary.status === "blocked" && summary.committed === false,
  workflow: "prompt-transfer-ukiyoe",
  stage: "automation_os_prompt_transfer_blocker_reconciliation_receipt",
  generated_at: new Date().toISOString(),
  automation_os_db_mutated: commitRequested && exactBlocker === "google_service_account_json_missing" && summary.status === "blocked" && summary.committed === false,
  strict_registered_success_claimed: false,
  reconciliation_status: commitRequested
    ? "project_owned_credential_blocker_recorded_as_reconciliation_readback"
    : "project_owned_credential_blocker_ready_for_reconciliation_readback",
  registered_workflow_id: "prompt-transfer-ukiyoe",
  automation_os_latest_run: latestPromptTransferRun
    ? {
        id: latestPromptTransferRun.id,
        status: latestPromptTransferRun.status,
        created_at: latestPromptTransferRun.created_at,
        updated_at: latestPromptTransferRun.updated_at
      }
    : null,
  project_run: {
    run_id: stringValue(summary.run_id),
    summary_path: summaryPath,
    plan_path: planPath,
    status: stringValue(summary.status),
    exact_blocker: exactBlocker,
    retry_from_stage: stringValue(summary.retry_from_stage),
    commit_requested: booleanValue(summary.commit_requested),
    allow_external_commit: booleanValue(summary.allow_external_commit),
    committed: booleanValue(summary.committed),
    source_url: stringValue(summary.source_url),
    target_url: stringValue(summary.target_url),
    theme: stringValue(summary.theme),
    planned_range: plannedRange,
    append_row: numberValue(plan.append_row),
    external_actions_performed: false,
    google_sheets_write_performed: false,
    strict_registered_success_claimed: false,
    proof_gate: proofGate,
    proof_summary: `blocked: ${exactBlocker}`
  },
  next_safe_action:
    "Keep Prompt Transfer blocked until an approved GOOGLE_SERVICE_ACCOUNT_JSON secret lane is available; then rerun the commit stage and capture commit.json plus same-range Google Sheets readback.",
  stop_conditions: [
    "billing_purchase_payment_checkout",
    "captcha_otp_security_code_identity_verification",
    "google_service_account_json_missing",
    "external_sheets_write_without_approved_secret_and_readback"
  ]
};

mkdirSync(outDir, { recursive: true });
const receiptPath = join(outDir, "prompt-transfer-blocker-reconciliation-receipt.json");
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
const committedRun = commitRequested && receipt.ok ? commitBlockerReadback(receiptPath) : null;

console.log(
  JSON.stringify(
    {
      ok: receipt.ok,
      receiptPath,
      receiptUri: pathToFileURL(receiptPath).href,
      committedRun,
      latestAutomationOsRun: receipt.automation_os_latest_run,
      projectRun: {
        run_id: receipt.project_run.run_id,
        exact_blocker: receipt.project_run.exact_blocker,
        proof_gate: receipt.project_run.proof_gate,
        planned_range: receipt.project_run.planned_range,
        committed: receipt.project_run.committed
      },
      nextSafeAction: receipt.next_safe_action
    },
    null,
    2
  )
);
process.exitCode = receipt.ok ? 0 : 1;

function commitBlockerReadback(receiptPath: string): { runId: string; proofId: string } {
  if (!latestPromptTransferRun) throw new Error("automation_os_latest_prompt_transfer_run_missing");
  const runId = makeId("run_prompt_transfer_reconcile");
  const stepId = `${runId}_step_1`;
  const proofId = makeId("proof_prompt_transfer_reconcile");
  const eventId = makeId("evt_prompt_transfer_reconcile");
  const now = nowIso();
  const metadata = {
    registeredWorkflowId: "prompt-transfer-ukiyoe",
    registered_workflow_id: "prompt-transfer-ukiyoe",
    reconciliation_run: true,
    reconciliation_of_run_id: latestPromptTransferRun.id,
    project_run_id: receipt.project_run.run_id,
    project_summary_path: summaryPath,
    project_plan_path: planPath,
    exact_blocker: receipt.project_run.exact_blocker,
    retry_from_stage: receipt.project_run.retry_from_stage,
    commit_requested: receipt.project_run.commit_requested,
    allow_external_commit: receipt.project_run.allow_external_commit,
    committed: receipt.project_run.committed,
    planned_range: receipt.project_run.planned_range,
    append_row: receipt.project_run.append_row,
    external_actions_performed: false,
    google_sheets_write_performed: false,
    strict_registered_success_claimed: false,
    proof_gate: receipt.project_run.proof_gate,
    proof_summary: receipt.project_run.proof_summary
  };
  insert("runs", {
    id: runId,
    name: "Prompt Transfer blocker reconciliation readback",
    status: "blocked",
    objective: "Record Prompt Transfer credential blocker as Automation OS reconciliation readback without writing to Google Sheets",
    created_at: now,
    updated_at: now,
    metadata_json: metadata
  });
  insert("run_steps", {
    id: stepId,
    run_id: runId,
    name: "Record Prompt Transfer blocker reconciliation readback",
    status: "blocked",
    lane_id: null,
    started_at: now,
    completed_at: now,
    metadata_json: {
      adapter: "prompt_transfer_blocker_reconciliation_readback",
      requires_approval: false,
      dangerous_action: false,
      external_actions_performed: false,
      google_sheets_write_performed: false,
      proof_gate: receipt.project_run.proof_gate,
      proof_summary: receipt.project_run.proof_summary
    }
  });
  insert("proofs", {
    id: proofId,
    run_id: runId,
    step_id: stepId,
    proof_type: proofType,
    label: "Prompt Transfer blocker reconciliation readback",
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
    message: receipt.project_run.proof_summary,
    created_at: now,
    metadata_json: metadata
  });
  return { runId, proofId };
}

function readLatestPromptTransferRun(): RunRow | null {
  if (dbBackend !== "sqlite") throw new Error("prompt_transfer_reconciliation_requires_local_sqlite_readback");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return (
      db
        .prepare(
          `
          SELECT id, name, status, created_at, updated_at, metadata_json
          FROM runs
          WHERE COALESCE(json_extract(metadata_json,'$.registeredWorkflowId'), json_extract(metadata_json,'$.registered_workflow_id'))='prompt-transfer-ukiyoe'
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

function plannedRangeFromPlan(plan: JsonRecord): string {
  const rows = Array.isArray(plan.rows) ? plan.rows : [];
  const first = recordValue(rows[0]);
  const themeCell = stringValue(first?.theme_cell);
  const adoptedCell = stringValue(first?.adopted_cell);
  return themeCell && adoptedCell ? `${themeCell}:${adoptedCell}` : "";
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

function booleanValue(value: unknown): boolean {
  return value === true;
}

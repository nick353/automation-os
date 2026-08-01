import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { insert, makeId, nowIso } from "../db/client.js";
import { buildCanonicalExecutionRoutingMetadataForCommand } from "../codex/executionRouting.js";
import { resolveExactSourceRunBinding, type RunRow } from "./sourceRunBinding.js";

const defaultRunDir = "/Users/nichikatanaka/Documents/New project/artifacts/run-summaries/codex-app-job-application-manager-20260702-153200";
const runDir = resolve(readArgValue("--run-dir") ?? defaultRunDir);
const outDir = resolve(readArgValue("--out-dir") ?? `data/artifacts/job-application-manager/reconciliation-${timestamp()}`);
const commitRequested = process.argv.includes("--commit");

type JsonRecord = Record<string, unknown>;

const submittedSummary = readJson("submitted-count-by-bucket-summary.json");
const normalizationReceipt = readJson("user-action-normalization-receipt.json");
const completionAudit = readJson("completion-audit-after-user-action-normalization.json");
const historicalFullTargetAudit = readJson("completion-audit-full-target-readback-now.json");
const historicalNormalizedAudit = readJson("completion-audit-after-normalized-proof.json");
const sourceRun = resolveExactSourceRunBinding({
  expectedWorkflowId: "job-application-manager",
  explicitSourceRunId: readArgValue("--source-run-id")
});
const sourceRunCompanyId = normalizeCompanyId(sourceRun.company_id);
if (!sourceRunCompanyId) throw new Error("source_run_company_id_missing");

const counts = recordValue(submittedSummary.submitted_count_by_bucket);
const japanTargeted = numberValue(counts?.japan_targeted);
const overseasGlobal = numberValue(counts?.overseas_global);
const completionFailedChecks = Array.isArray(completionAudit.failed_checks) ? completionAudit.failed_checks : [];
const historicalAuditStates = {
  "completion-audit-full-target-readback-now.json": Boolean(historicalFullTargetAudit.ok),
  "completion-audit-after-normalized-proof.json": Boolean(historicalNormalizedAudit.ok)
};
const routeMetadata = buildCanonicalExecutionRoutingMetadataForCommand({
  command: "Record Job completion reconciliation readback",
  source: "manual",
  selectedAdapter: "job_reconciliation_readback"
});
const checks = [
  {
    name: "automation_os_latest_job_run_present",
    ok: Boolean(sourceRun),
    detail: `${sourceRun.id}:${sourceRun.status}`
  },
  {
    name: "source_run_company_id_present",
    ok: Boolean(sourceRunCompanyId),
    detail: sourceRunCompanyId ?? "missing"
  },
  {
    name: "submitted_split_target_20_20_proven",
    ok: submittedSummary.ok === true && japanTargeted >= 20 && overseasGlobal >= 20,
    detail: `japan_targeted=${japanTargeted}; overseas_global=${overseasGlobal}`
  },
  {
    name: "user_action_normalization_ok",
    ok: normalizationReceipt.ok === true,
    detail: `final_user_action_count=${numberValue(normalizationReceipt.final_user_action_count)}; resolved_non_user_action_count=${numberValue(
      normalizationReceipt.resolved_non_user_action_count
    )}`
  },
  {
    name: "completion_audit_after_user_action_normalization_ok",
    ok: completionAudit.ok === true && completionFailedChecks.length === 0,
    detail: `failed_checks=${completionFailedChecks.length}`
  },
  {
    name: "historical_failed_audits_preserved_as_historical",
    ok: historicalFullTargetAudit.ok === false && historicalNormalizedAudit.ok === false,
    detail: JSON.stringify(historicalAuditStates)
  }
];
const ok = checks.every((check) => check.ok);
const receipt = {
  ok,
  workflow: "job-applications",
  stage: "automation_os_job_completion_reconciliation_receipt",
  generated_at: new Date().toISOString(),
  automation_os_db_mutated: commitRequested && ok,
  strict_registered_success_claimed: false,
  reconciliation_status: ok
    ? commitRequested
      ? "project_owned_completion_recorded_as_reconciliation_readback"
      : "project_owned_completion_ready_for_registered_readback"
    : "blocked",
  registered_workflow_id: "job-application-manager",
  automation_os_latest_run: {
    id: sourceRun.id,
    status: sourceRun.status,
    created_at: sourceRun.created_at,
    updated_at: sourceRun.updated_at
  },
  project_run: {
    run_id: stringValue(submittedSummary.run_id),
    source_run_company_id: sourceRunCompanyId,
    exact_blocker: null,
    run_dir: runDir,
    submitted_count_by_bucket: { japan_targeted: japanTargeted, overseas_global: overseasGlobal },
    completion_audit: join(runDir, "completion-audit-after-user-action-normalization.json"),
    submitted_count_summary: join(runDir, "submitted-count-by-bucket-summary.json"),
    user_action_normalization_receipt: join(runDir, "user-action-normalization-receipt.json")
  },
  checks,
  next_safe_action:
    "Run the registered Job Application Manager definition in proof/readback mode from current state, or add an explicit DB/UI reconciliation path that references this receipt; do not submit more applications unless a fresh audit disproves the split counts.",
  stop_conditions: [
    "billing_purchase_payment_checkout",
    "captcha_otp_security_code_identity_verification",
    "assessment_test",
    "unknown_personal_facts",
    "external_action_without_source_of_truth_and_cleanup_proof"
  ]
};

mkdirSync(outDir, { recursive: true });
const receiptPath = join(outDir, "job-completion-reconciliation-receipt.json");
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
const committedRun = commitRequested && ok ? commitReconciliationReadback(receiptPath, sourceRun, sourceRunCompanyId) : null;
console.log(
  JSON.stringify(
    {
      ok,
      receiptPath,
      receiptUri: pathToFileURL(receiptPath).href,
      committedRun,
      latestAutomationOsRun: receipt.automation_os_latest_run,
      submittedCountByBucket: receipt.project_run.submitted_count_by_bucket,
      nextSafeAction: receipt.next_safe_action
    },
    null,
    2
  )
);
process.exitCode = ok ? 0 : 1;

function readJson(fileName: string): JsonRecord {
  return JSON.parse(readFileSync(join(runDir, fileName), "utf8")) as JsonRecord;
}

function readArgValue(name: string): string | undefined {
  const match = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return match?.slice(name.length + 1);
}

function commitReconciliationReadback(
  receiptPath: string,
  sourceRun: RunRow,
  companyId: string | null
): { runId: string; proofId: string } {
  if (!companyId) throw new Error("source_run_company_id_missing");
  const runId = makeId("run_job_reconcile");
  const stepId = `${runId}_step_1`;
  const proofId = makeId("proof_job_reconcile");
  const eventId = makeId("evt_job_reconcile");
  const now = nowIso();
  const proofType = "job_completion_reconciliation_readback";
  const metadata = {
    registeredWorkflowId: "job-application-manager",
    registered_workflow_id: "job-application-manager",
    reconciliation_run: true,
    reconciliation_of_run_id: sourceRun.id,
    project_run_id: stringValue(submittedSummary.run_id),
    project_run_dir: runDir,
    project_completion_audit: join(runDir, "completion-audit-after-user-action-normalization.json"),
    submitted_count_by_bucket: { japan_targeted: japanTargeted, overseas_global: overseasGlobal },
    user_action_normalization_ok: normalizationReceipt.ok === true,
    completion_audit_after_user_action_normalization_ok: completionAudit.ok === true && completionFailedChecks.length === 0,
    historical_failed_audits_preserved: historicalFullTargetAudit.ok === false && historicalNormalizedAudit.ok === false,
    external_actions_performed: false,
    additional_applications_submitted: false,
    strict_registered_success_claimed: false,
    proof_gate: { ok: true, missing: [], present: [proofType] },
    proof_summary: "complete: Job completion reconciliation readback recorded without additional submissions",
    ...routeMetadata
  };
  insert("runs", {
    id: runId,
    company_id: companyId,
    name: "Job completion reconciliation readback",
    status: "complete",
    objective: "Record project-owned Job completion proof as Automation OS reconciliation readback without submitting more applications",
    created_at: now,
    updated_at: now,
    metadata_json: metadata
  });
  insert("run_steps", {
    id: stepId,
    run_id: runId,
    company_id: companyId,
    name: "Record Job completion reconciliation readback",
    status: "completed",
    lane_id: null,
    started_at: now,
    completed_at: now,
    metadata_json: {
      adapter: "job_reconciliation_readback",
      requires_approval: false,
      dangerous_action: false,
      external_actions_performed: false,
      additional_applications_submitted: false,
      proof_gate: metadata.proof_gate,
      proof_summary: metadata.proof_summary,
      ...routeMetadata
    }
  });
  insert("proofs", {
    id: proofId,
    company_id: companyId,
    run_id: runId,
    step_id: stepId,
    proof_type: proofType,
    label: "Job completion reconciliation readback",
    uri: pathToFileURL(receiptPath).href,
    size_bytes: Buffer.byteLength(readFileSync(receiptPath)),
    created_at: now,
    metadata_json: metadata
  });
  insert("worker_events", {
    id: eventId,
    run_id: runId,
    step_id: stepId,
    company_id: companyId,
    lane_id: null,
    event_type: "worker_completed",
    message: metadata.proof_summary,
    created_at: now,
    metadata_json: metadata
  });
  return { runId, proofId };
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

function normalizeCompanyId(value: unknown): string | null {
  const companyId = stringValue(value).trim();
  return companyId ? companyId : null;
}

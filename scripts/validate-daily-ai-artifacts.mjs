import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DAILY_AI_ARTIFACT_CONSISTENCY_SCHEMA = "aos.daily_ai_artifact_consistency_report.v1";
export const DEFAULT_COMPANION_WORKFLOW = {
  run_id: "run_14adeb906f54489b",
  status: "waiting",
  current_stage: "final_review",
  source: "current_workflow_status_readback",
};

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_PATHS = Object.freeze({
  goal: join(PROJECT_ROOT, "GOAL.md"),
  plan: join(PROJECT_ROOT, "Plan.md"),
  state: join(PROJECT_ROOT, "STATE.md"),
  ledger: join(PROJECT_ROOT, "work/job-candidate-decision-ledger-20260830.v1.json"),
  digest: join(PROJECT_ROOT, "work/job-application-digest-preview-20260830.v1.json"),
  matrix: join(PROJECT_ROOT, "work/job-candidate-evidence-matrix-20260830.v1.json"),
  sheet: join(PROJECT_ROOT, "work/job-application-sheet-mirror-preview-20260830.v1.json"),
  audit: join(PROJECT_ROOT, "work/daily-ai-registered-no-effect-receipt-audit-20260830.v1.json"),
  report: join(PROJECT_ROOT, "work/daily-ai-artifact-consistency-report-20260830.v1.json"),
});

const EXPECTED_SCHEMAS = Object.freeze({
  ledger: "aos.job_application_candidate_decision_ledger.v1",
  digest: "aos.job_application_daily_digest_preview.v1",
  matrix: "aos.job_application_candidate_evidence_matrix.v1",
  sheet: "aos.job_application_sheet_mirror_preview.v1",
  audit: "aos.daily_ai_registered_no_effect_receipt_audit.v1",
});

const REQUIRED_UNKNOWN_DOWNSTREAM_FIELDS = Object.freeze([
  "dispatch_count",
  "provider_action_count",
  "sheet_mutation_count",
  "source_sync_state",
  "reconciliation_state",
  "business_completion",
]);

export class ArtifactConsistencyError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "ArtifactConsistencyError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, details = {}) {
  throw new ArtifactConsistencyError(code, details);
}

function requireCondition(condition, code, details = {}) {
  if (!condition) fail(code, details);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function sha256File(filePath) {
  requireCondition(existsSync(filePath), "local_artifact_missing", { path: filePath });
  return sha256Buffer(readFileSync(filePath));
}

function readJson(filePath) {
  requireCondition(existsSync(filePath), "local_artifact_missing", { path: filePath });
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    fail("local_artifact_json_invalid", { path: filePath, message: error.message });
  }
}

function text(value) {
  return typeof value === "string" ? value : "";
}

function sameArray(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sorted(values) {
  return [...values].sort();
}

function candidateKeysFromLedger(ledger) {
  return ledger.records.map((record) => record.candidate_key);
}

function ensureUnique(values, code, details = {}) {
  requireCondition(new Set(values).size === values.length, code, { ...details, values });
}

function addCheck(checks, id, detail) {
  checks.push({ id, status: "pass", detail });
}

function assertSchema(documents, checks) {
  for (const [name, schema] of Object.entries(EXPECTED_SCHEMAS)) {
    requireCondition(documents[name]?.schema === schema, "local_artifact_schema_or_identity_mismatch", {
      artifact: name,
      expected_schema: schema,
      observed_schema: documents[name]?.schema ?? null,
    });
  }
  addCheck(checks, "artifact_schemas", "All five run-owned inputs use their expected versioned schemas.");
}

function assertGoalPlanIdentity(documents, sourceFiles, checks) {
  const ownerTaskIds = [
    documents.ledger.owner?.task_id,
    documents.digest.owner?.task_id,
    documents.matrix.owner?.task_id,
    documents.sheet.owner?.task_id,
    documents.audit.owner_task_id,
  ];
  requireCondition(ownerTaskIds.every(Boolean), "current_goal_plan_identity_unresolvable", {
    reason: "one or more artifact owners do not expose a task id",
  });
  requireCondition(ownerTaskIds.every((taskId) => taskId === ownerTaskIds[0]), "current_goal_plan_identity_unresolvable", {
    reason: "artifact owner task ids disagree",
    values: ownerTaskIds,
  });
  requireCondition(documents.matrix.owner?.goal_status === "active", "current_goal_plan_identity_unresolvable", {
    observed_goal_status: documents.matrix.owner?.goal_status ?? null,
  });
  requireCondition(documents.matrix.owner?.plan_identity_preserved === true, "current_goal_plan_identity_unresolvable", {
    reason: "plan identity is not marked preserved",
  });
  requireCondition(text(documents.matrix.owner?.plan_source).endsWith("Plan.md"), "current_goal_plan_identity_unresolvable", {
    observed_plan_source: documents.matrix.owner?.plan_source ?? null,
  });
  requireCondition(sourceFiles.goal.text.includes("# GOAL.md"), "current_goal_plan_identity_unresolvable", {
    reason: "GOAL.md marker missing",
  });
  requireCondition(sourceFiles.plan.text.includes("# Current plan pointer"), "current_goal_plan_identity_unresolvable", {
    reason: "Plan.md current pointer marker missing",
  });
  requireCondition(sourceFiles.state.text.length > 0, "current_goal_plan_identity_unresolvable", {
    reason: "STATE.md is empty",
  });
  addCheck(checks, "goal_plan_identity", "All five artifacts share one active owner task; GOAL.md, Plan.md, and STATE.md are present and the plan pointer is preserved.");
}

function assertCandidateLedger(ledger, checks) {
  requireCondition(Array.isArray(ledger.records) && ledger.records.length === 4, "local_artifact_schema_or_identity_mismatch", {
    artifact: "ledger",
    observed_record_count: ledger.records?.length ?? null,
  });
  requireCondition(ledger.source_count === 4 && ledger.unique_count === 4 && ledger.duplicate_count === 0, "local_artifact_schema_or_identity_mismatch", {
    artifact: "ledger",
    source_count: ledger.source_count,
    unique_count: ledger.unique_count,
    duplicate_count: ledger.duplicate_count,
  });
  const keys = candidateKeysFromLedger(ledger);
  ensureUnique(keys, "local_artifact_schema_or_identity_mismatch", { artifact: "ledger", field: "candidate_key" });
  ensureUnique(ledger.records.map((record) => record.canonical_identity?.canonical_url), "local_artifact_schema_or_identity_mismatch", {
    artifact: "ledger",
    field: "canonical_identity.canonical_url",
  });
  requireCondition(ledger.decision_counts?.apply === 0 && ledger.decision_counts?.skip === 0 && ledger.decision_counts?.hold === 4, "local_artifact_schema_or_identity_mismatch", {
    artifact: "ledger",
    decision_counts: ledger.decision_counts,
  });
  requireCondition(ledger.reconciliation?.one_to_one_source_mapping === true && ledger.reconciliation?.decision_count_sum === 4, "local_artifact_schema_or_identity_mismatch", {
    artifact: "ledger",
    reconciliation: ledger.reconciliation,
  });
  for (const record of ledger.records) {
    requireCondition(record.application_decision === "hold", "local_artifact_schema_or_identity_mismatch", {
      artifact: "ledger",
      candidate_key: record.candidate_key,
      decision: record.application_decision,
    });
    requireCondition(record.external_action_executed === false, "local_artifact_effect_state_invalid", {
      artifact: "ledger",
      candidate_key: record.candidate_key,
    });
  }
  requireCondition(ledger.readback?.status === "verified" && ledger.readback?.external_action_executed === false, "local_artifact_effect_state_invalid", {
    artifact: "ledger",
    readback: ledger.readback,
  });
  addCheck(checks, "candidate_ledger", "Exactly four unique candidates agree with the verified 0 apply / 0 skip / 4 hold ledger and no candidate effect was executed.");
  return keys;
}

function assertDigest(digest, ledgerKeys, checks) {
  const digestKeys = digest.candidates.map((candidate) => candidate.candidate_key);
  requireCondition(sameArray(digestKeys, ledgerKeys), "local_artifact_schema_or_identity_mismatch", {
    artifact: "digest",
    field: "candidate_key",
  });
  for (const period of ["morning", "evening"]) {
    const view = digest.views?.[period];
    requireCondition(view?.status === "read_only_preview" && sameArray(view.candidate_keys, ledgerKeys), "local_artifact_schema_or_identity_mismatch", {
      artifact: "digest",
      period,
    });
    requireCondition(view.decision_counts?.apply === 0 && view.decision_counts?.skip === 0 && view.decision_counts?.hold === 4, "local_artifact_schema_or_identity_mismatch", {
      artifact: "digest",
      period,
      decision_counts: view.decision_counts,
    });
  }
  requireCondition(digest.summary?.source_count === 4 && digest.summary?.unique_count === 4 && digest.summary?.duplicate_count === 0, "local_artifact_schema_or_identity_mismatch", {
    artifact: "digest",
    summary: digest.summary,
  });
  requireCondition(digest.summary?.decision_counts?.hold === 4 && digest.summary?.decision_counts?.apply === 0 && digest.summary?.decision_counts?.skip === 0, "local_artifact_schema_or_identity_mismatch", {
    artifact: "digest",
    summary: digest.summary,
  });
  for (const [field, expected] of Object.entries({
    external_action_executed: false,
    aos_write: false,
    provider_write: false,
    sheet_write: false,
    browser_operation: false,
    schedule_changed: false,
  })) {
    requireCondition(digest.scope?.[field] === expected, "local_artifact_effect_state_invalid", {
      artifact: "digest",
      field,
      observed: digest.scope?.[field] ?? null,
    });
  }
  requireCondition(digest.readback?.status === "verified" && digest.readback?.candidate_key_parity === true && digest.readback?.external_action_executed === false, "local_artifact_effect_state_invalid", {
    artifact: "digest",
    readback: digest.readback,
  });
  addCheck(checks, "morning_evening_digest", "Morning and evening read-only views contain the same four ledger candidates with 4 holds and no writes.");
}

function assertMatrix(matrix, ledgerKeys, checks) {
  const matrixKeys = matrix.candidates.map((candidate) => candidate.candidate_key);
  requireCondition(sameArray(matrixKeys, ledgerKeys), "local_artifact_schema_or_identity_mismatch", {
    artifact: "matrix",
    field: "candidate_key",
  });
  requireCondition(matrix.counts?.candidate_count === 4 && matrix.counts?.required_field_count === 16 && matrix.counts?.unknown_field_count === 12, "local_artifact_schema_or_identity_mismatch", {
    artifact: "matrix",
    counts: matrix.counts,
  });
  requireCondition(matrix.counts?.decision_ready_count === 0 && matrix.counts?.ledger_hold_count === 4, "local_artifact_schema_or_identity_mismatch", {
    artifact: "matrix",
    counts: matrix.counts,
  });
  for (const candidate of matrix.candidates) {
    requireCondition(candidate.decision_ready === false && candidate.ledger_decision === "hold", "local_artifact_schema_or_identity_mismatch", {
      artifact: "matrix",
      candidate_key: candidate.candidate_key,
    });
    requireCondition(candidate.fields?.company?.status === "unknown", "local_artifact_schema_or_identity_mismatch", {
      artifact: "matrix",
      candidate_key: candidate.candidate_key,
      field: "company",
    });
    requireCondition(candidate.fields?.salary?.status === "unknown" && candidate.fields?.work_authorization?.status === "unknown", "local_artifact_schema_or_identity_mismatch", {
      artifact: "matrix",
      candidate_key: candidate.candidate_key,
      field: "salary_or_work_authorization",
    });
    requireCondition(candidate.fields?.role?.status === "present_but_generic" && candidate.fields?.role?.decision_ready === false, "local_artifact_schema_or_identity_mismatch", {
      artifact: "matrix",
      candidate_key: candidate.candidate_key,
      field: "role",
    });
  }
  requireCondition(matrix.external_action_executed === false && matrix.readback?.status === "verified" && matrix.readback?.all_fields_attributed_or_unknown === true && matrix.readback?.external_action_executed === false, "local_artifact_effect_state_invalid", {
    artifact: "matrix",
    readback: matrix.readback,
  });
  addCheck(checks, "candidate_evidence_matrix", "All 16 required fields are either attributed or unknown; 12 remain unknown and all four decisions remain hold.");
}

function assertSheetMirror(sheet, ledgerKeys, checks) {
  const rowKeys = sheet.rows.map((row) => row.candidate_key);
  requireCondition(sameArray(rowKeys, ledgerKeys), "local_artifact_schema_or_identity_mismatch", {
    artifact: "sheet",
    field: "candidate_key",
  });
  requireCondition(sheet.schema_binding?.column_count === 20 && Array.isArray(sheet.schema_binding?.columns) && sheet.schema_binding.columns.length === 20, "local_artifact_schema_or_identity_mismatch", {
    artifact: "sheet",
    field: "column_count",
  });
  for (const row of sheet.rows) {
    requireCondition(Array.isArray(row.values) && row.values.length === 20 && row.decision === "hold", "local_artifact_schema_or_identity_mismatch", {
      artifact: "sheet",
      candidate_key: row.candidate_key,
    });
  }
  for (const [field, expected] of Object.entries({
    external_action_executed: false,
    remote_sheet_write_performed: false,
    provider_call_performed: false,
    schedule_changed: false,
  })) {
    requireCondition(sheet.scope?.[field] === expected, "local_artifact_effect_state_invalid", {
      artifact: "sheet",
      field,
      observed: sheet.scope?.[field] ?? null,
    });
  }
  requireCondition(sheet.schema_binding?.remote_destination?.write_allowed === false && sheet.readback?.status === "verified" && sheet.readback?.candidate_key_parity === true && sheet.readback?.external_action_executed === false, "local_artifact_effect_state_invalid", {
    artifact: "sheet",
    readback: sheet.readback,
  });
  addCheck(checks, "sheet_mirror_preview", "The 20-column Sheet-mirror preview has four matching rows, no bound remote destination, and no write/provider/schedule effect.");
}

function assertHashReference(reference, checks, label) {
  const observed = sha256File(reference.path);
  requireCondition(observed === reference.sha256, "local_artifact_source_hash_mismatch", {
    artifact: label,
    path: reference.path,
    expected_sha256: reference.sha256,
    observed_sha256: observed,
  });
}

function assertDailyAiAudit(audit, checks) {
  requireCondition(audit.historical_reference_only === true, "local_artifact_schema_or_identity_mismatch", {
    artifact: "audit",
    field: "historical_reference_only",
  });
  requireCondition(audit.readback?.selected_receipt_count === 1 && audit.readback?.explicit_no_effect_fields_preserved === true && audit.readback?.missing_fields_preserved_as_unknown === true, "local_artifact_schema_or_identity_mismatch", {
    artifact: "audit",
    readback: audit.readback,
  });
  const receipt = audit.source_receipt_readback;
  for (const [field, expected] of Object.entries({
    ok: true,
    accepted: true,
    queued: true,
    provider_neutral: true,
    external_action_executed: false,
    run_status: "queued",
    fallback_decision: "none",
  })) {
    requireCondition(receipt?.[field] === expected, "local_artifact_effect_state_invalid", {
      artifact: "audit",
      field,
      expected,
      observed: receipt?.[field] ?? null,
    });
  }
  for (const field of REQUIRED_UNKNOWN_DOWNSTREAM_FIELDS) {
    requireCondition(audit.downstream_effect_readback?.[field] === "unknown", "daily_ai_unknown_downstream_field_promoted", {
      field,
      observed: audit.downstream_effect_readback?.[field] ?? null,
    });
  }
  for (const [field, expected] of Object.entries({
    cleanup_verified: true,
    provider_sessions: 0,
    browser_sessions: 0,
    owned_trigger_processes_after_exit: 0,
    provider_stage_invocations: 0,
    browser_stage_invocations: 0,
    publish_invocations: 0,
    engagement_invocations: 0,
    upload_invocations: 0,
    sheet_write_invocations: 0,
    external_action_executed: false,
  })) {
    requireCondition(audit.trigger_scope_effect_readback?.[field] === expected, "local_artifact_effect_state_invalid", {
      artifact: "audit",
      field,
      expected,
      observed: audit.trigger_scope_effect_readback?.[field] ?? null,
    });
  }
  requireCondition(audit.run_invocation_performed === false && audit.replay_performed === false && audit.readback?.aos_run_invoked_by_audit === false, "local_artifact_effect_state_invalid", {
    artifact: "audit",
    run_invocation_performed: audit.run_invocation_performed,
    replay_performed: audit.replay_performed,
  });
  addCheck(checks, "daily_ai_no_effect_receipt", "The single historical trigger receipt preserves only explicit queued/no-effect facts; downstream effect and reconciliation fields remain unknown.");
}

function assertCompanionSeparation(audit, companionWorkflow, checks) {
  requireCondition(companionWorkflow && text(companionWorkflow.run_id), "current_workflow_readback_missing", {
    reason: "current Companion workflow status was not supplied",
  });
  requireCondition(companionWorkflow.status === "waiting" && companionWorkflow.current_stage === "final_review", "current_workflow_readback_unexpected", {
    observed: companionWorkflow,
  });
  requireCondition(companionWorkflow.run_id !== audit.receipt_selection.receipt_run_id, "local_artifact_schema_or_identity_mismatch", {
    reason: "Companion audit run was confused with Daily AI trigger run",
    companion_run_id: companionWorkflow.run_id,
    daily_ai_run_id: audit.receipt_selection.receipt_run_id,
  });
  addCheck(checks, "companion_workflow_separation", `Companion workflow ${companionWorkflow.run_id} is separate and remains waiting at final_review; it is not Daily AI downstream proof.`);
}

export function loadArtifactBundle(paths = DEFAULT_PATHS) {
  const sourceFiles = {};
  for (const name of ["goal", "plan", "state"]) {
    requireCondition(existsSync(paths[name]), "current_goal_plan_identity_unresolvable", { path: paths[name] });
    sourceFiles[name] = {
      path: paths[name],
      text: readFileSync(paths[name], "utf8"),
      sha256: sha256File(paths[name]),
      bytes: statSync(paths[name]).size,
    };
  }
  const documents = {};
  for (const name of Object.keys(EXPECTED_SCHEMAS)) {
    documents[name] = readJson(paths[name]);
  }
  return { documents, sourceFiles, paths: { ...paths } };
}

export function validateArtifactBundle({ documents, sourceFiles, paths = DEFAULT_PATHS, companionWorkflow = DEFAULT_COMPANION_WORKFLOW, generatedAt = new Date().toISOString() }) {
  requireCondition(documents && sourceFiles, "current_goal_plan_identity_unresolvable", { reason: "artifact bundle is incomplete" });
  const checks = [];
  assertSchema(documents, checks);
  assertGoalPlanIdentity(documents, sourceFiles, checks);
  const ledgerKeys = assertCandidateLedger(documents.ledger, checks);
  assertDigest(documents.digest, ledgerKeys, checks);
  assertMatrix(documents.matrix, ledgerKeys, checks);
  assertSheetMirror(documents.sheet, ledgerKeys, checks);
  assertHashReference({
    path: documents.audit.receipt_selection.selected_receipt_path,
    sha256: documents.audit.receipt_selection.selected_receipt_sha256,
  }, checks, "daily_ai_receipt");
  assertHashReference({
    path: documents.audit.trigger_scope_effect_readback.cleanup_proof_path,
    sha256: documents.audit.trigger_scope_effect_readback.cleanup_proof_sha256,
  }, checks, "daily_ai_cleanup_proof");
  assertHashReference({
    path: documents.audit.trigger_blocker_readback.path,
    sha256: documents.audit.trigger_blocker_readback.sha256,
  }, checks, "daily_ai_trigger_blocker");
  assertDailyAiAudit(documents.audit, checks);
  assertCompanionSeparation(documents.audit, companionWorkflow, checks);

  const ownerTaskId = documents.ledger.owner.task_id;
  const report = {
    schema: DAILY_AI_ARTIFACT_CONSISTENCY_SCHEMA,
    report_version: 1,
    generated_at: generatedAt,
    owner_task_id: ownerTaskId,
    goal_plan_identity: {
      goal_status: documents.matrix.owner.goal_status,
      plan_identity_preserved: documents.matrix.owner.plan_identity_preserved,
      goal_path: sourceFiles.goal.path,
      goal_sha256: sourceFiles.goal.sha256,
      plan_path: sourceFiles.plan.path,
      plan_sha256: sourceFiles.plan.sha256,
      state_path: sourceFiles.state.path,
      state_sha256: sourceFiles.state.sha256,
    },
    source_artifacts: Object.fromEntries(Object.entries(documents).map(([name, document]) => ({
      [name]: {
        path: paths[name],
        sha256: sha256File(paths[name]),
        schema: document.schema,
      },
    }))),
    candidate_consistency: {
      candidate_count: ledgerKeys.length,
      candidate_keys: ledgerKeys,
      decision_counts: { apply: 0, skip: 0, hold: 4 },
      unknown_evidence_fields: 12,
      decision_ready_count: 0,
    },
    daily_ai_receipt: {
      run_id: documents.audit.receipt_selection.receipt_run_id,
      historical_reference_only: true,
      accepted: true,
      queued: true,
      provider_neutral: true,
      external_action_executed: false,
      downstream: Object.fromEntries(REQUIRED_UNKNOWN_DOWNSTREAM_FIELDS.map((field) => [field, "unknown"])),
    },
    companion_workflow: {
      run_id: companionWorkflow.run_id,
      status: companionWorkflow.status,
      current_stage: companionWorkflow.current_stage,
      source: companionWorkflow.source ?? "current_workflow_status_readback",
      separate_from_daily_ai: true,
    },
    effect_boundary: {
      external_action_executed: false,
      provider_called: false,
      browser_called: false,
      sheet_written: false,
      schedule_changed: false,
      run_invocation_performed: false,
      replay_performed: false,
      business_completion: "PENDING_CONFIRMATION",
    },
    checks,
    result: "passed_local_consistency_only",
    exact_blocker: "daily_ai_business_completion_pending_downstream_effect_readback",
    restart_point: "Use a newly authorized fresh downstream readback for the same objective only after production token and registered identity capability are available; never replay the historical trigger receipt.",
  };
  return report;
}

export function validateCurrentArtifacts(options = {}) {
  const paths = { ...DEFAULT_PATHS, ...(options.paths ?? {}) };
  const bundle = loadArtifactBundle(paths);
  return validateArtifactBundle({
    ...bundle,
    paths,
    companionWorkflow: options.companionWorkflow ?? DEFAULT_COMPANION_WORKFLOW,
    generatedAt: options.generatedAt,
  });
}

function parseCompanionArg(argv) {
  const marker = "--companion-status-json";
  const index = argv.indexOf(marker);
  if (index < 0) return DEFAULT_COMPANION_WORKFLOW;
  const raw = argv[index + 1];
  requireCondition(raw, "current_workflow_readback_missing", { reason: `${marker} requires JSON` });
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail("current_workflow_readback_invalid", { message: error.message });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const report = validateCurrentArtifacts({ companionWorkflow: parseCompanionArg(process.argv.slice(2)) });
    writeFileSync(DEFAULT_PATHS.report, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    console.log(JSON.stringify({
      status: "passed",
      report_path: DEFAULT_PATHS.report,
      report_schema: report.schema,
      check_count: report.checks.length,
      candidate_count: report.candidate_consistency.candidate_count,
      downstream_unknown_fields: Object.keys(report.daily_ai_receipt.downstream).length,
      external_action_executed: report.effect_boundary.external_action_executed,
      schedule_changed: report.effect_boundary.schedule_changed,
    }));
  } catch (error) {
    const output = {
      status: "failed",
      exact_blocker: error.code ?? "daily_ai_artifact_consistency_validation_failed",
      details: error.details ?? {},
    };
    console.error(JSON.stringify(output));
    process.exitCode = 1;
  }
}

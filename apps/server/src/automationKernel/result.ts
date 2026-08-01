import type { AutomationKernelDefinitionV1, AutomationKernelSnapshotV1, JsonObject } from "./contracts.js";

export type AutomationKernelResultTerminalStatusV2 = "succeeded" | "blocked" | "failed";
export type AutomationKernelResultStageStatusV2 = AutomationKernelResultTerminalStatusV2 | "reconciliation_required";

export type AutomationKernelResultStageV2 = {
  stage_id: string;
  status: AutomationKernelResultStageStatusV2;
  exact_blocker: string | null;
  artifact_uris: string[];
  cleanup_proof: string | null;
  claim_id: string | null;
  receipt_id: string | null;
  proof_uri: string | null;
  details: JsonObject;
};

export type AutomationKernelResultV2 = {
  schema: "automation_kernel_result.v2";
  automation_id?: string;
  workflow_id: string;
  run_id: string;
  terminal_status: AutomationKernelResultTerminalStatusV2;
  selected_stages: string[];
  stage_results: AutomationKernelResultStageV2[];
  exact_blocker: string | null;
  restart_stage: string | null;
  artifact_uris: string[];
  cleanup_proof: string | null;
};

export class AutomationKernelResultError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "AutomationKernelResultError";
  }
}

const allowedTopLevelFields = new Set([
  "schema",
  "automation_id",
  "workflow_id",
  "run_id",
  "terminal_status",
  "selected_stages",
  "stage_results",
  "exact_blocker",
  "restart_stage",
  "artifact_uris",
  "cleanup_proof"
]);

const allowedStageFields = new Set([
  "stage_id",
  "status",
  "exact_blocker",
  "artifact_uris",
  "cleanup_proof",
  "claim_id",
  "receipt_id",
  "proof_uri",
  "details"
]);

export function createAutomationKernelResultV2(input: {
  automationId?: string;
  workflowId: string;
  runId: string;
  terminalStatus: AutomationKernelResultTerminalStatusV2;
  selectedStages: string[];
  stageResults: AutomationKernelResultStageV2[];
  exactBlocker?: string | null;
  restartStage?: string | null;
  artifactUris?: string[];
  cleanupProof?: string | null;
}): AutomationKernelResultV2 {
  const result: AutomationKernelResultV2 = {
    schema: "automation_kernel_result.v2",
    ...(input.automationId === undefined
      ? {}
      : { automation_id: stringValue(input.automationId, "automation_kernel_result_automation_id") }),
    workflow_id: stringValue(input.workflowId, "automation_kernel_result_workflow_id"),
    run_id: stringValue(input.runId, "automation_kernel_result_run_id"),
    terminal_status: input.terminalStatus,
    selected_stages: arrayOfStrings(input.selectedStages, "automation_kernel_result_selected_stages"),
    stage_results: input.stageResults.map((stage, index) => normalizeStage(stage, index)),
    exact_blocker: optionalString(input.exactBlocker),
    restart_stage: optionalString(input.restartStage),
    artifact_uris: arrayOfStrings(input.artifactUris ?? [], "automation_kernel_result_artifact_uris"),
    cleanup_proof: optionalString(input.cleanupProof)
  };
  validateResult(result);
  return result;
}

export function parseAutomationKernelResultV2(value: unknown): AutomationKernelResultV2 {
  const body = objectValue(value, "automation_kernel_result_required");
  rejectUnknownFields(body, allowedTopLevelFields, "automation_kernel_result_unknown_field");
  if (body.schema !== "automation_kernel_result.v2") throw new AutomationKernelResultError("automation_kernel_result_schema_invalid");
  const result: AutomationKernelResultV2 = {
    schema: "automation_kernel_result.v2",
    ...(Object.prototype.hasOwnProperty.call(body, "automation_id")
      ? { automation_id: stringValue(body.automation_id, "automation_kernel_result_automation_id") }
      : {}),
    workflow_id: stringValue(body.workflow_id, "automation_kernel_result_workflow_id"),
    run_id: stringValue(body.run_id, "automation_kernel_result_run_id"),
    terminal_status: terminalStatusValue(body.terminal_status),
    selected_stages: arrayOfStrings(body.selected_stages, "automation_kernel_result_selected_stages"),
    stage_results: arrayValue(body.stage_results, "automation_kernel_result_stage_results").map((stage, index) => parseStage(stage, index)),
    exact_blocker: optionalString(body.exact_blocker),
    restart_stage: optionalString(body.restart_stage),
    artifact_uris: arrayOfStrings(body.artifact_uris, "automation_kernel_result_artifact_uris"),
    cleanup_proof: optionalString(body.cleanup_proof)
  };
  validateResult(result);
  return result;
}

export function assertAutomationKernelResultMatchesSnapshot(
  result: AutomationKernelResultV2,
  definition: AutomationKernelDefinitionV1,
  snapshot: AutomationKernelSnapshotV1
): void {
  const workflowId = typeof definition.metadata.workflow_id === "string" ? definition.metadata.workflow_id : "";
  const runId = typeof definition.metadata.run_id === "string" ? definition.metadata.run_id : "";
  if (result.workflow_id !== workflowId || result.run_id !== runId) {
    throw new AutomationKernelResultError("automation_kernel_result_identity_mismatch");
  }
  const definitionStageIds = definition.effects.map((effect) => effect.effect_id);
  const incompleteAlwaysRun = snapshot.effects.filter((effect) =>
    effect.payload.always_run === true
    && effect.status !== "succeeded"
    && effect.status !== "failed"
    && effect.status !== "reconciliation_required"
  );
  if (incompleteAlwaysRun.length > 0) {
    throw new AutomationKernelResultError(`automation_kernel_result_always_run_incomplete:${incompleteAlwaysRun.map((effect) => effect.effect_id).join(",")}`);
  }
  const terminalStageIds = snapshot.effects
    .filter((effect) => effect.status === "succeeded" || effect.status === "failed" || effect.status === "reconciliation_required")
    .map((effect) => effect.effect_id);
  if (JSON.stringify(terminalStageIds) !== JSON.stringify(result.selected_stages)) {
    throw new AutomationKernelResultError("automation_kernel_result_selected_stages_not_terminal_order");
  }
  for (const stageResult of result.stage_results) {
    const effect = snapshot.effects.find((candidate) => candidate.effect_id === stageResult.stage_id);
    if (!effect) throw new AutomationKernelResultError("automation_kernel_result_stage_missing");
    const allowedStatuses: AutomationKernelResultStageStatusV2[] = effect.status === "succeeded"
      ? ["succeeded"]
      : effect.status === "failed"
        ? ["failed", "blocked"]
        : effect.status === "reconciliation_required"
          ? ["reconciliation_required"]
          : [];
    if (!allowedStatuses.includes(stageResult.status)) {
      throw new AutomationKernelResultError(`automation_kernel_result_stage_status_mismatch:${stageResult.stage_id}`);
    }
    if (stageResult.claim_id !== effect.claim_id || stageResult.receipt_id !== effect.receipt_id) {
      throw new AutomationKernelResultError(`automation_kernel_result_stage_receipt_mismatch:${stageResult.stage_id}`);
    }
  }
  if (result.restart_stage !== null && !definitionStageIds.includes(result.restart_stage)) {
    throw new AutomationKernelResultError("automation_kernel_result_restart_stage_invalid");
  }
  if (result.terminal_status === "succeeded") {
    if (snapshot.status !== "complete" || result.selected_stages.length !== definitionStageIds.length) {
      throw new AutomationKernelResultError("automation_kernel_result_success_snapshot_incomplete");
    }
    return;
  }
  if (result.exact_blocker !== snapshot.exact_blocker) {
    throw new AutomationKernelResultError("automation_kernel_result_exact_blocker_mismatch");
  }
  if (result.terminal_status === "blocked" && snapshot.status !== "reconciliation_required" && snapshot.status !== "blocked") {
    throw new AutomationKernelResultError("automation_kernel_result_blocked_snapshot_mismatch");
  }
  if (result.terminal_status === "failed" && snapshot.status !== "blocked") {
    throw new AutomationKernelResultError("automation_kernel_result_failed_snapshot_mismatch");
  }
}

function normalizeStage(stage: AutomationKernelResultStageV2, index: number): AutomationKernelResultStageV2 {
  const normalized: AutomationKernelResultStageV2 = {
    stage_id: stringValue(stage.stage_id, `automation_kernel_result_stage_id:${index}`),
    status: stageStatusValue(stage.status, `automation_kernel_result_stage_status:${index}`),
    exact_blocker: optionalString(stage.exact_blocker),
    artifact_uris: arrayOfStrings(stage.artifact_uris, `automation_kernel_result_stage_artifact_uris:${index}`),
    cleanup_proof: optionalString(stage.cleanup_proof),
    claim_id: optionalString(stage.claim_id),
    receipt_id: optionalString(stage.receipt_id),
    proof_uri: optionalString(stage.proof_uri),
    details: objectValue(stage.details, `automation_kernel_result_stage_details:${index}`)
  };
  rejectUnknownFields(normalized as Record<string, unknown>, allowedStageFields, `automation_kernel_result_stage_unknown_field:${index}`);
  return normalized;
}

function parseStage(value: unknown, index: number): AutomationKernelResultStageV2 {
  const body = objectValue(value, `automation_kernel_result_stage_required:${index}`);
  rejectUnknownFields(body, allowedStageFields, `automation_kernel_result_stage_unknown_field:${index}`);
  return normalizeStage(
    {
      stage_id: body.stage_id as string,
      status: body.status as AutomationKernelResultStageStatusV2,
      exact_blocker: (body.exact_blocker ?? null) as string | null,
      artifact_uris: body.artifact_uris as string[],
      cleanup_proof: (body.cleanup_proof ?? null) as string | null,
      claim_id: (body.claim_id ?? null) as string | null,
      receipt_id: (body.receipt_id ?? null) as string | null,
      proof_uri: (body.proof_uri ?? null) as string | null,
      details: body.details as JsonObject
    },
    index
  );
}

function validateResult(result: AutomationKernelResultV2): void {
  if (result.selected_stages.length === 0) throw new AutomationKernelResultError("automation_kernel_result_selected_stages_required");
  if (new Set(result.selected_stages).size !== result.selected_stages.length) {
    throw new AutomationKernelResultError("automation_kernel_result_selected_stages_duplicate");
  }
  const stageIds = result.stage_results.map((stage) => stage.stage_id);
  if (new Set(stageIds).size !== stageIds.length) throw new AutomationKernelResultError("automation_kernel_result_stage_id_duplicate");
  if (JSON.stringify(stageIds) !== JSON.stringify(result.selected_stages)) {
    throw new AutomationKernelResultError("automation_kernel_result_stage_results_selection_mismatch");
  }
  if (result.terminal_status === "succeeded") {
    if (result.exact_blocker !== null) throw new AutomationKernelResultError("automation_kernel_result_success_exact_blocker_forbidden");
    if (result.restart_stage !== null) throw new AutomationKernelResultError("automation_kernel_result_success_restart_stage_forbidden");
    if (!result.cleanup_proof) throw new AutomationKernelResultError("automation_kernel_result_success_cleanup_proof_required");
    if (result.stage_results.some((stage) => stage.status !== "succeeded")) {
      throw new AutomationKernelResultError("automation_kernel_result_success_stage_status_invalid");
    }
    return;
  }
  if (result.terminal_status === "blocked") {
    if (!result.exact_blocker) throw new AutomationKernelResultError("automation_kernel_result_blocked_exact_blocker_required");
    if (!result.restart_stage) throw new AutomationKernelResultError("automation_kernel_result_blocked_restart_stage_required");
    if (!result.cleanup_proof) throw new AutomationKernelResultError("automation_kernel_result_blocked_cleanup_proof_required");
    return;
  }
  if (!result.exact_blocker) throw new AutomationKernelResultError("automation_kernel_result_failed_exact_blocker_required");
  if (!result.restart_stage) throw new AutomationKernelResultError("automation_kernel_result_failed_restart_stage_required");
  if (!result.cleanup_proof) throw new AutomationKernelResultError("automation_kernel_result_failed_cleanup_proof_required");
}

function terminalStatusValue(value: unknown): AutomationKernelResultTerminalStatusV2 {
  if (value !== "succeeded" && value !== "blocked" && value !== "failed") {
    throw new AutomationKernelResultError("automation_kernel_result_terminal_status_invalid");
  }
  return value;
}

function stageStatusValue(value: unknown, code: string): AutomationKernelResultStageStatusV2 {
  if (value !== "succeeded" && value !== "blocked" && value !== "failed" && value !== "reconciliation_required") {
    throw new AutomationKernelResultError(code);
  }
  return value;
}

function objectValue(value: unknown, code: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AutomationKernelResultError(code);
  return value as JsonObject;
}

function arrayValue(value: unknown, code: string): unknown[] {
  if (!Array.isArray(value)) throw new AutomationKernelResultError(code);
  return value;
}

function rejectUnknownFields(body: Record<string, unknown>, allowed: Set<string>, code: string): void {
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) throw new AutomationKernelResultError(`${code}:${unknown.sort().join(",")}`);
}

function stringValue(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new AutomationKernelResultError(code);
  return value.trim();
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return stringValue(value, "automation_kernel_result_string_invalid");
}

function arrayOfStrings(value: unknown, code: string): string[] {
  return arrayValue(value, code).map((entry, index) => stringValue(entry, `${code}_item:${index}`));
}

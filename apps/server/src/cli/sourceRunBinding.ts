import Database from "better-sqlite3";
import { dbBackend, dbPath } from "../db/client.js";

export type RunRow = {
  id: string;
  company_id: string | null;
  name: string;
  status: string;
  created_at: string;
  updated_at: string;
  metadata_json: string;
};

type JsonRecord = Record<string, unknown>;

export function resolveExactSourceRunBinding(input: {
  expectedWorkflowId: string;
  explicitSourceRunId?: string | null;
  artifactAutomationOsRunId?: string | null;
  artifactAutomationOsRunIdCamel?: string | null;
  artifactRunIdFallback?: string | null;
  allowArtifactRunIdFallback?: boolean;
}): RunRow {
  const sourceRunId = resolveUniqueSourceRunId({
    artifactAutomationOsRunId: input.artifactAutomationOsRunId,
    artifactAutomationOsRunIdCamel: input.artifactAutomationOsRunIdCamel,
    artifactRunIdFallback: input.allowArtifactRunIdFallback ? input.artifactRunIdFallback : null,
    explicitSourceRunId: input.explicitSourceRunId
  });

  if (!sourceRunId) {
    throw new Error("source_run_id_required");
  }

  const sourceRun = readRunById(sourceRunId);
  if (!sourceRun) {
    throw new Error("source_run_not_found");
  }

  const metadata = readJsonRecord(sourceRun.metadata_json);
  const workflowId = registeredWorkflowIdFromMetadata(metadata);
  if (workflowId !== input.expectedWorkflowId) {
    throw new Error("source_run_workflow_identity_mismatch");
  }

  if (metadata.reconciliation_run === true || nonEmptyString(metadata.reconciliation_of_run_id)) {
    throw new Error("source_run_reconciliation_run_not_allowed");
  }

  return sourceRun;
}

function resolveUniqueSourceRunId(input: {
  explicitSourceRunId?: string | null;
  artifactAutomationOsRunId?: string | null;
  artifactAutomationOsRunIdCamel?: string | null;
  artifactRunIdFallback?: string | null;
}): string {
  const candidates = [
    normalizeSourceRunId(input.artifactAutomationOsRunId),
    normalizeSourceRunId(input.artifactAutomationOsRunIdCamel),
    normalizeSourceRunId(input.artifactRunIdFallback),
    normalizeSourceRunId(input.explicitSourceRunId)
  ].filter((candidate) => candidate.length > 0);
  const uniqueCandidates = [...new Set(candidates)];
  if (uniqueCandidates.length > 1) {
    throw new Error("source_run_id_conflict");
  }
  return uniqueCandidates[0] ?? "";
}

function readRunById(runId: string): RunRow | null {
  if (dbBackend !== "sqlite") {
    throw new Error("source_run_binding_requires_local_sqlite_readback");
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return (
      db
        .prepare(
          `
          SELECT id, company_id, name, status, created_at, updated_at, metadata_json
          FROM runs
          WHERE id = ?
          LIMIT 1;
        `
        )
        .get(runId) as RunRow | undefined
    ) ?? null;
  } finally {
    db.close();
  }
}

function readJsonRecord(value: string): JsonRecord {
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("source_run_metadata_invalid");
  }
  return parsed as JsonRecord;
}

function registeredWorkflowIdFromMetadata(metadata: JsonRecord): string {
  const candidates = collectWorkflowIdCandidates(metadata);
  const uniqueCandidates = [...new Set(candidates)];
  if (uniqueCandidates.length > 1) {
    throw new Error("source_run_workflow_conflict");
  }
  return uniqueCandidates[0] ?? "";
}

function collectWorkflowIdCandidates(metadata: JsonRecord): string[] {
  const candidates = collectWorkflowIdAliases(metadata);
  const nestedMetadata = metadata.metadata;
  if (isJsonRecord(nestedMetadata)) {
    candidates.push(...collectWorkflowIdCandidates(nestedMetadata));
  }
  const registeredWorkflowStart = metadata.registered_workflow_start;
  if (isJsonRecord(registeredWorkflowStart)) {
    candidates.push(...collectWorkflowIdCandidates(registeredWorkflowStart));
  }
  return candidates;
}

function collectWorkflowIdAliases(record: JsonRecord): string[] {
  return [
    nonEmptyString(record.registeredWorkflowId),
    nonEmptyString(record.registered_workflow_id),
    nonEmptyString(record.workflowId),
    nonEmptyString(record.workflow_id),
    nonEmptyString(record.AUTOMATION_OS_REGISTERED_WORKFLOW_ID)
  ].filter((candidate): candidate is string => candidate.length > 0);
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeSourceRunId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nonEmptyString(value: unknown): string {
  return normalizeSourceRunId(value);
}

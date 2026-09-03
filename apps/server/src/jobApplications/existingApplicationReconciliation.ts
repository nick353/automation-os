import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { makeId, nowIso, querySql, querySqlAsync, sqlValue, type SqlTransactionStep } from "../db/client.js";
import { runIdempotentSqlMutation } from "../automations/idempotency.js";
import { CHROME_PLUGIN_PROFILE2_AUTH_REF } from "../runs/webOperationBackendSettings.js";

export const EXISTING_APPLICATION_RECONCILIATION_SCHEMA = "aos_existing_application_reconciliation.v1" as const;
export const EXISTING_APPLICATION_RECONCILIATION_PROOF_TYPE = "job_application_reconciliation_readback" as const;
export const EXISTING_APPLICATION_RECONCILIATION_BLOCKER = "aos_same_run_source_sync_not_completed" as const;

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_URL = /^https?:\/\/[^\s@/]+(?:\/[^\s]*)?$/iu;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/@+\\-]{0,999}$/u;
const MAX_ARTIFACT_BYTES = 1_000_000;
const PROVIDER_CONFIRMATION = "Application status: Application submitted" as const;

export class ExistingApplicationReconciliationError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "ExistingApplicationReconciliationError";
  }
}

type JsonRecord = Record<string, unknown>;

export type ExistingApplicationReconciliationInput = {
  artifactRef: string;
  artifactSha256: string;
};

export type ExistingApplicationReconciliationResult = {
  schema: typeof EXISTING_APPLICATION_RECONCILIATION_SCHEMA;
  replayed: boolean;
  run: { id: string; status: "complete"; company_id: string };
  proof: { id: string; type: typeof EXISTING_APPLICATION_RECONCILIATION_PROOF_TYPE };
  target: { job_url: string; company: string; role: string };
  browser_auth: {
    backend: "chrome_plugin";
    profile_id: "profile2";
    auth_ref: typeof CHROME_PLUGIN_PROFILE2_AUTH_REF;
    company_connection_ref_required: false;
  };
  provider_readback: {
    visible_confirmation: typeof PROVIDER_CONFIRMATION;
    visible_submission_success: true;
    existing_external_effect_observed: true;
    same_run_submission_receipt: false;
  };
  source_sync: { status: "synced"; artifact_sha256: string };
  reconciliation: { status: "reconciled"; mode: "reconciliation_only" };
  business_completion_claimed: false;
  external_action_executed: false;
  exact_blocker: typeof EXISTING_APPLICATION_RECONCILIATION_BLOCKER;
  next_action: "do_not_resubmit_or_replay";
};

type VerifiedArtifact = {
  absolutePath: string;
  sha256: string;
  sizeBytes: number;
  target: { job_url: string; company: string; role: string };
};

export function recordExistingApplicationReconciliation(input: {
  companyId: string;
  idempotencyKey: string;
  reconciliation: ExistingApplicationReconciliationInput;
}): ExistingApplicationReconciliationResult {
  const companyId = requiredRef(input.companyId, "company_id_required");
  const idempotencyKey = requiredRef(input.idempotencyKey, "reconciliation_idempotency_key_required");
  const verified = verifyReconciliationArtifact(input.reconciliation);
  const request = {
    schema: EXISTING_APPLICATION_RECONCILIATION_SCHEMA,
    company_id: companyId,
    artifact_ref: input.reconciliation.artifactRef,
    artifact_sha256: verified.sha256,
    target: verified.target
  };
  const runId = makeId("run_job_reconcile");
  const stepId = `${runId}_step_1`;
  const proofId = makeId("proof_job_reconcile");
  const eventId = makeId("evt_job_reconcile");
  const createdAt = nowIso();
  const metadata = {
    schema: EXISTING_APPLICATION_RECONCILIATION_SCHEMA,
    reconciliation_only: true,
    workflow_id: "job-application-manager",
    provider: "linkedin",
    browser_backend: "chrome_plugin",
    browser_surface: "signed_chrome_extension_profile2",
    browser_auth: {
      profile_id: "profile2",
      auth_ref: CHROME_PLUGIN_PROFILE2_AUTH_REF,
      company_connection_ref_required: false
    },
    target: verified.target,
    provider_readback: {
      visible_confirmation: PROVIDER_CONFIRMATION,
      visible_submission_success: true,
      existing_external_effect_observed: true,
      same_run_submission_receipt: false
    },
    source_sync: {
      status: "synced",
      artifact_ref: input.reconciliation.artifactRef,
      artifact_sha256: verified.sha256
    },
    reconciliation: { status: "reconciled", mode: "reconciliation_only" },
    business_completion_claimed: false,
    external_action_executed: false,
    additional_external_action_executed: false,
    exact_blocker: EXISTING_APPLICATION_RECONCILIATION_BLOCKER,
    next_action: "do_not_resubmit_or_replay",
    cleanup: { status: "verified", remaining_tabs: 0 }
  } satisfies JsonRecord;
  const result: ExistingApplicationReconciliationResult = {
    schema: EXISTING_APPLICATION_RECONCILIATION_SCHEMA,
    replayed: false,
    run: { id: runId, status: "complete", company_id: companyId },
    proof: { id: proofId, type: EXISTING_APPLICATION_RECONCILIATION_PROOF_TYPE },
    target: verified.target,
    browser_auth: {
      backend: "chrome_plugin",
      profile_id: "profile2",
      auth_ref: CHROME_PLUGIN_PROFILE2_AUTH_REF,
      company_connection_ref_required: false
    },
    provider_readback: {
      visible_confirmation: PROVIDER_CONFIRMATION,
      visible_submission_success: true,
      existing_external_effect_observed: true,
      same_run_submission_receipt: false
    },
    source_sync: { status: "synced", artifact_sha256: verified.sha256 },
    reconciliation: { status: "reconciled", mode: "reconciliation_only" },
    business_completion_claimed: false,
    external_action_executed: false,
    exact_blocker: EXISTING_APPLICATION_RECONCILIATION_BLOCKER,
    next_action: "do_not_resubmit_or_replay"
  };
  const resourceSteps: SqlTransactionStep[] = [
    {
      sql: `INSERT INTO runs
        (id, company_id, automation_id, automation_version_id, name, status, objective, created_at, updated_at, metadata_json, execution_source, quarantined, readback_proof_id)
        VALUES (${sqlValue(runId)}, ${sqlValue(companyId)}, NULL, NULL,
          ${sqlValue("Job application existing submission reconciliation")}, ${sqlValue("complete")},
          ${sqlValue("Reconcile an already-submitted provider readback without resubmitting")},
          ${sqlValue(createdAt)}, ${sqlValue(createdAt)}, ${sqlValue(metadata)}, ${sqlValue("automation-os")}, 0, NULL)`,
      expectChanges: 1
    },
    {
      sql: `INSERT INTO run_steps
        (id, run_id, company_id, name, status, lane_id, started_at, completed_at, metadata_json)
        VALUES (${sqlValue(stepId)}, ${sqlValue(runId)}, ${sqlValue(companyId)},
          ${sqlValue("Record existing application reconciliation")}, ${sqlValue("completed")}, NULL,
          ${sqlValue(createdAt)}, ${sqlValue(createdAt)}, ${sqlValue({ ...metadata, dangerous_action: false })})`,
      expectChanges: 1
    },
    {
      sql: `INSERT INTO proofs
        (id, company_id, run_id, step_id, artifact_id, attempt_id, fencing_token, proof_type, label, uri, size_bytes, created_at, metadata_json)
        VALUES (${sqlValue(proofId)}, ${sqlValue(companyId)}, ${sqlValue(runId)}, ${sqlValue(stepId)}, NULL, NULL, NULL,
          ${sqlValue(EXISTING_APPLICATION_RECONCILIATION_PROOF_TYPE)},
          ${sqlValue("Existing application reconciliation readback")},
          ${sqlValue(pathToFileURL(verified.absolutePath).href)}, ${verified.sizeBytes}, ${sqlValue(createdAt)}, ${sqlValue(metadata)})`,
      expectChanges: 1
    },
    {
      sql: `UPDATE runs SET readback_proof_id=${sqlValue(proofId)} WHERE id=${sqlValue(runId)} AND company_id=${sqlValue(companyId)}`,
      expectChanges: 1
    },
    {
      sql: `INSERT INTO worker_events
        (id, run_id, step_id, company_id, lane_id, event_type, message, created_at, metadata_json)
        VALUES (${sqlValue(eventId)}, ${sqlValue(runId)}, ${sqlValue(stepId)}, ${sqlValue(companyId)}, NULL,
          ${sqlValue("worker_completed")},
          ${sqlValue("Existing application readback reconciled without resubmission")},
          ${sqlValue(createdAt)}, ${sqlValue(metadata)})`,
      expectChanges: 1
    }
  ];
  const idempotent = runIdempotentSqlMutation({
    companyId,
    scope: "job_application_existing_submission_reconciliation",
    key: idempotencyKey,
    request,
    resourceSteps,
    response: result
  });
  return idempotent.replayed ? { ...idempotent.response, replayed: true } : result;
}

export function listExistingApplicationReconciliations(companyId: string): Array<{
  run_id: string;
  proof_id: string | null;
  created_at: string;
  target: { job_url: string; company: string; role: string } | null;
  source_sync: { status: string; artifact_sha256: string } | null;
  external_action_executed: false;
  business_completion_claimed: false;
}> {
  const normalizedCompanyId = requiredRef(companyId, "company_id_required");
  return projectReconciliationRows(querySql<{ id: string; readback_proof_id: string | null; created_at: string; metadata_json: string }>(`
    SELECT id, readback_proof_id, created_at, metadata_json
    FROM runs
    WHERE company_id=${sqlValue(normalizedCompanyId)}
      AND execution_source='automation-os'
      AND metadata_json LIKE '%"reconciliation_only":true%'
    ORDER BY created_at DESC
    LIMIT 50
  `));
}

export async function listExistingApplicationReconciliationsAsync(companyId: string): Promise<ReturnType<typeof listExistingApplicationReconciliations>> {
  const normalizedCompanyId = requiredRef(companyId, "company_id_required");
  const rows = await querySqlAsync<{ id: string; readback_proof_id: string | null; created_at: string; metadata_json: string }>(`
    SELECT id, readback_proof_id, created_at, metadata_json
    FROM runs
    WHERE company_id=${sqlValue(normalizedCompanyId)}
      AND execution_source='automation-os'
      AND metadata_json LIKE '%"reconciliation_only":true%'
    ORDER BY created_at DESC
    LIMIT 50
  `);
  return projectReconciliationRows(rows);
}

function projectReconciliationRows(rows: Array<{ id: string; readback_proof_id: string | null; created_at: string; metadata_json: string }>): ReturnType<typeof listExistingApplicationReconciliations> {
  return rows.map((row) => {
    const metadata = parseRecord(row.metadata_json);
    return {
      run_id: row.id,
      proof_id: row.readback_proof_id,
      created_at: row.created_at,
      target: recordTarget(metadata.target),
      source_sync: recordSourceSync(metadata.source_sync),
      external_action_executed: false,
      business_completion_claimed: false
    };
  });
}

function verifyReconciliationArtifact(input: ExistingApplicationReconciliationInput): VerifiedArtifact {
  const artifactRef = requiredArtifactRef(input.artifactRef);
  const expectedSha = requiredHash(input.artifactSha256, "reconciliation_artifact_sha256_invalid");
  const absolutePath = resolveAllowedArtifactPath(artifactRef);
  let stat;
  try {
    stat = statSync(absolutePath);
  } catch {
    throw new ExistingApplicationReconciliationError("reconciliation_artifact_readback_missing");
  }
  if (!stat.isFile()) throw new ExistingApplicationReconciliationError("reconciliation_artifact_not_file");
  if (stat.size > MAX_ARTIFACT_BYTES) throw new ExistingApplicationReconciliationError("reconciliation_artifact_too_large");
  const bytes = readFileSync(absolutePath);
  const actualSha = createHash("sha256").update(bytes).digest("hex");
  if (actualSha !== expectedSha) throw new ExistingApplicationReconciliationError("reconciliation_artifact_sha256_mismatch");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ExistingApplicationReconciliationError("reconciliation_artifact_json_invalid");
  }
  const record = objectValue(parsed, "reconciliation_artifact_shape_invalid");
  if (record.schema !== "aos_application_reconciliation_readback.v1") {
    throw new ExistingApplicationReconciliationError("reconciliation_artifact_schema_invalid");
  }
  const target = objectValue(record.target, "reconciliation_target_missing");
  const jobUrl = safeUrl(target.job_url, "reconciliation_target_job_url_invalid");
  const company = requiredText(target.company, "reconciliation_target_company_missing");
  const role = requiredText(target.role, "reconciliation_target_role_missing");
  const browserAuth = objectValue(record.browser_auth, "reconciliation_browser_auth_missing");
  if (browserAuth.backend !== "chrome_plugin" || browserAuth.profile_id !== "profile2" || browserAuth.auth_ref !== CHROME_PLUGIN_PROFILE2_AUTH_REF || browserAuth.company_connection_ref_required !== false) {
    throw new ExistingApplicationReconciliationError("reconciliation_profile2_binding_invalid");
  }
  const provider = objectValue(record.provider_readback, "reconciliation_provider_readback_missing");
  if (provider.surface !== "Chrome Plugin / Profile 2" || provider.visible_confirmation !== PROVIDER_CONFIRMATION || provider.visible_submission_success !== true || provider.same_run_receipt !== false || provider.additional_external_action_executed !== false) {
    throw new ExistingApplicationReconciliationError("reconciliation_provider_readback_invalid");
  }
  const cleanup = objectValue(record.chrome_agent_tab_cleanup, "reconciliation_cleanup_missing");
  if (cleanup.status !== "verified" || cleanup.remaining_tabs !== 0 || record.external_action_executed !== false) {
    throw new ExistingApplicationReconciliationError("reconciliation_cleanup_or_effect_boundary_invalid");
  }
  return { absolutePath, sha256: actualSha, sizeBytes: bytes.byteLength, target: { job_url: jobUrl, company, role } };
}

function resolveAllowedArtifactPath(ref: string): string {
  const candidate = resolve(ref);
  const roots = [
    process.env.AUTOMATION_OS_ARTIFACT_ROOT?.trim(),
    resolve(process.cwd(), "work")
  ].filter((value): value is string => Boolean(value)).map((value) => resolve(value));
  if (!roots.some((root) => candidate === root || relative(root, candidate) && !relative(root, candidate).startsWith(".." + "/") && relative(root, candidate) !== "..")) {
    throw new ExistingApplicationReconciliationError("reconciliation_artifact_path_outside_root");
  }
  return candidate;
}

function objectValue(value: unknown, code: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ExistingApplicationReconciliationError(code);
  return value as JsonRecord;
}

function parseRecord(value: string): JsonRecord {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonRecord : {};
  } catch {
    return {};
  }
}

function recordTarget(value: unknown): { job_url: string; company: string; role: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as JsonRecord;
  if (typeof record.job_url !== "string" || typeof record.company !== "string" || typeof record.role !== "string") return null;
  return { job_url: record.job_url, company: record.company, role: record.role };
}

function recordSourceSync(value: unknown): { status: string; artifact_sha256: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as JsonRecord;
  if (typeof record.status !== "string" || typeof record.artifact_sha256 !== "string") return null;
  return { status: record.status, artifact_sha256: record.artifact_sha256 };
}

function safeUrl(value: unknown, code: string): string {
  if (typeof value !== "string" || !SAFE_URL.test(value.trim()) || value.length > 2000) throw new ExistingApplicationReconciliationError(code);
  return value.trim();
}

function requiredText(value: unknown, code: string, max = 240): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new ExistingApplicationReconciliationError(code);
  return value.trim();
}

function requiredRef(value: unknown, code: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max || !SAFE_REF.test(value.trim())) throw new ExistingApplicationReconciliationError(code);
  return value.trim();
}

function requiredArtifactRef(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\u0000") || value.trim().length > 1000) {
    throw new ExistingApplicationReconciliationError("reconciliation_artifact_ref_required");
  }
  return value.trim();
}

function requiredHash(value: unknown, code: string): string {
  if (typeof value !== "string" || !SHA256.test(value.trim())) throw new ExistingApplicationReconciliationError(code);
  return value.trim();
}

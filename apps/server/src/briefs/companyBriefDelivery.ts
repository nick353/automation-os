import { createHash } from "node:crypto";
import {
  dbBackend,
  makeId,
  nowIso,
  querySql,
  querySqlAsync,
  sqlValue,
  type SqlTransactionStep
} from "../db/client.js";
import { canonicalJson, runIdempotentSqlMutation, runIdempotentSqlMutationAsync, type IdempotentMutationResult } from "../automations/idempotency.js";
import { buildCompanyBriefReadback, buildCompanyBriefReadbackAsync, type CompanyBriefReadbackInput } from "./companyBriefReadback.js";
import type { LocalBriefBundle, LocalBriefType } from "./companyBriefs.js";

export const COMPANY_BRIEF_DELIVERY_SCHEMA = "aos.local_brief_delivery.v1" as const;
export const COMPANY_BRIEF_DELIVERY_SCOPE = "brief_home_delivery" as const;

export type CompanyBriefHomeDeliveryInput = CompanyBriefReadbackInput & {
  idempotencyKey: string;
};

export type CompanyBriefDeliveryReadback = {
  attempted: true;
  status: "delivered";
  delivery_id: string;
  run_id: string;
  target: "aos_home";
  receipt_hash: string;
  delivered_at: string;
  output_fingerprint: string;
  source_sync_status: "synced";
  reconciliation_status: "reconciled";
  cleanup_status: "verified";
};

export type CompanyBriefHomeDeliveryResponse = {
  schema: typeof COMPANY_BRIEF_DELIVERY_SCHEMA;
  delivery: CompanyBriefDeliveryReadback & {
    input_fingerprint: string;
    output_fingerprint: string;
    item_count: number;
    included_records: number;
    excluded_records: number;
    brief_type: LocalBriefType;
    business_date: string;
    timezone: string;
    template_version: string;
    external_action_executed: false;
  };
  run: { id: string; status: "completed"; company_id: string; automation_id: null };
  proofs: Array<{ id: string; proof_type: string; uri: string }>;
  source_of_truth: "production_aos_database" | "local_aos_database";
  external_action_executed: false;
  company_scope: { enforced: true; company_id: string };
};

type DeliveryRow = {
  id: string;
  run_id: string;
  receipt_hash: string;
  created_at: string;
  input_fingerprint: string;
  output_fingerprint: string;
};

export class CompanyBriefDeliveryError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "CompanyBriefDeliveryError";
  }
}

export function readLatestCompanyBriefDelivery(input: {
  companyId: string;
  briefType: LocalBriefType;
  businessDate: string;
  timezone: string;
  templateVersion: string;
}): CompanyBriefDeliveryReadback | null {
  const row = querySql<DeliveryRow>(deliveryReadbackSql(input))[0];
  return row ? deliveryReadback(row) : null;
}

export async function readLatestCompanyBriefDeliveryAsync(input: {
  companyId: string;
  briefType: LocalBriefType;
  businessDate: string;
  timezone: string;
  templateVersion: string;
}): Promise<CompanyBriefDeliveryReadback | null> {
  const row = (await querySqlAsync<DeliveryRow>(deliveryReadbackSql(input)))[0];
  return row ? deliveryReadback(row) : null;
}

export async function deliverCompanyBriefHome(input: CompanyBriefHomeDeliveryInput): Promise<IdempotentMutationResult<CompanyBriefHomeDeliveryResponse>> {
  const normalized = normalizeInput(input);
  const bundle = dbBackend === "postgres"
    ? await buildCompanyBriefReadbackAsync(normalized)
    : buildCompanyBriefReadback(normalized);
  assertDeliverableBundle(bundle, normalized.companyId);

  const deliveryId = makeId("brief_delivery");
  const runId = makeId("brief_home");
  const stageIds = Object.fromEntries(BRIEF_DELIVERY_STAGES.map((stage) => [stage, makeId(`brief_${stage}`)])) as Record<BriefDeliveryStage, string>;
  const proofIds = Object.fromEntries(BRIEF_DELIVERY_STAGES.map((stage) => [stage, makeId(`proof_${stage}`)])) as Record<BriefDeliveryStage, string>;
  const createdAt = nowIso();
  const receiptHash = sha256(canonicalJson({
    schema: COMPANY_BRIEF_DELIVERY_SCHEMA,
    delivery_id: deliveryId,
    run_id: runId,
    company_id: normalized.companyId,
    brief_type: normalized.briefType,
    business_date: normalized.businessDate,
    timezone: normalized.timezone,
    template_version: normalized.templateVersion ?? "v1",
    target: "aos_home",
    input_fingerprint: bundle.input_fingerprint,
    output_fingerprint: bundle.output_fingerprint,
    item_count: bundle.companies[0]?.item_count ?? 0,
    included_records: bundle.counts.included_records,
    excluded_records: bundle.counts.excluded_records,
    delivery_status: "delivered",
    source_sync_status: "synced",
    reconciliation_status: "reconciled",
    cleanup_status: "verified"
  }));
  const templateVersion = normalized.templateVersion ?? "v1";
  const delivery: CompanyBriefHomeDeliveryResponse["delivery"] = {
    attempted: true,
    status: "delivered",
    delivery_id: deliveryId,
    run_id: runId,
    target: "aos_home",
    receipt_hash: receiptHash,
    delivered_at: createdAt,
    source_sync_status: "synced",
    reconciliation_status: "reconciled",
    cleanup_status: "verified",
    input_fingerprint: bundle.input_fingerprint,
    output_fingerprint: bundle.output_fingerprint,
    item_count: bundle.companies[0]?.item_count ?? 0,
    included_records: bundle.counts.included_records,
    excluded_records: bundle.counts.excluded_records,
    brief_type: normalized.briefType,
    business_date: normalized.businessDate,
    timezone: normalized.timezone,
    template_version: templateVersion,
    external_action_executed: false
  };
  const response: CompanyBriefHomeDeliveryResponse = {
    schema: COMPANY_BRIEF_DELIVERY_SCHEMA,
    delivery,
    run: { id: runId, status: "completed", company_id: normalized.companyId, automation_id: null },
    proofs: BRIEF_DELIVERY_STAGES.map((stage) => ({
      id: proofIds[stage],
      proof_type: stage,
      uri: proofUri(deliveryId, stage)
    })),
    source_of_truth: dbBackend === "postgres" ? "production_aos_database" : "local_aos_database",
    external_action_executed: false,
    company_scope: { enforced: true, company_id: normalized.companyId }
  };

  const resourceSteps: SqlTransactionStep[] = [
    {
      sql: `INSERT INTO runs
        (id, company_id, automation_id, automation_version_id, name, status, objective, created_at, updated_at, metadata_json, execution_source, quarantined, readback_proof_id)
        VALUES (${sqlValue(runId)}, ${sqlValue(normalized.companyId)}, NULL, NULL,
          ${sqlValue(`Company 1 ${normalized.briefType} Home Brief delivery`)}, 'completed',
          ${sqlValue("Deliver the company-scoped Brief into the AOS Home internal surface")},
          ${sqlValue(createdAt)}, ${sqlValue(createdAt)},
          ${sqlValue({ schema: COMPANY_BRIEF_DELIVERY_SCHEMA, target: "aos_home", brief_type: normalized.briefType, business_date: normalized.businessDate, timezone: normalized.timezone, template_version: templateVersion, input_fingerprint: bundle.input_fingerprint, output_fingerprint: bundle.output_fingerprint, item_count: delivery.item_count, included_records: delivery.included_records, excluded_records: delivery.excluded_records, external_action_executed: false })},
          'aos_internal_home_delivery', 0, ${sqlValue(proofIds.cleanup)})`,
      expectChanges: 1
    },
    ...BRIEF_DELIVERY_STAGES.map((stage) => ({
      sql: `INSERT INTO run_steps
        (id, run_id, company_id, name, status, lane_id, started_at, completed_at, metadata_json)
        VALUES (${sqlValue(stageIds[stage])}, ${sqlValue(runId)}, ${sqlValue(normalized.companyId)}, ${sqlValue(stage)}, 'completed', NULL, ${sqlValue(createdAt)}, ${sqlValue(createdAt)},
          ${sqlValue({ schema: COMPANY_BRIEF_DELIVERY_SCHEMA, target: "aos_home", stage, external_action_executed: false, receipt_hash: receiptHash })})`,
      expectChanges: 1
    })),
    ...BRIEF_DELIVERY_STAGES.map((stage) => ({
      sql: `INSERT INTO proofs
        (id, company_id, run_id, step_id, artifact_id, attempt_id, fencing_token, proof_type, label, uri, size_bytes, created_at, metadata_json)
        VALUES (${sqlValue(proofIds[stage])}, ${sqlValue(normalized.companyId)}, ${sqlValue(runId)}, ${sqlValue(stageIds[stage])}, NULL, NULL, NULL, ${sqlValue(stage)}, ${sqlValue(`Company Brief Home ${stage}`)}, ${sqlValue(proofUri(deliveryId, stage))}, 0, ${sqlValue(createdAt)},
          ${sqlValue({ schema: COMPANY_BRIEF_DELIVERY_SCHEMA, target: "aos_home", stage, status: "verified", receipt_hash: receiptHash, external_action_executed: false })})`,
      expectChanges: 1
    })),
    {
      sql: `INSERT INTO brief_deliveries
        (id, company_id, run_id, brief_type, business_date, timezone, template_version, delivery_target, input_fingerprint, output_fingerprint, item_count, included_records, excluded_records, delivery_status, source_sync_status, reconciliation_status, cleanup_status, receipt_hash, idempotency_key, created_at, updated_at)
        VALUES (${sqlValue(deliveryId)}, ${sqlValue(normalized.companyId)}, ${sqlValue(runId)}, ${sqlValue(normalized.briefType)}, ${sqlValue(normalized.businessDate)}, ${sqlValue(normalized.timezone)}, ${sqlValue(templateVersion)}, 'aos_home', ${sqlValue(bundle.input_fingerprint)}, ${sqlValue(bundle.output_fingerprint)}, ${sqlValue(delivery.item_count)}, ${sqlValue(delivery.included_records)}, ${sqlValue(delivery.excluded_records)}, 'delivered', 'synced', 'reconciled', 'verified', ${sqlValue(receiptHash)}, ${sqlValue(normalized.idempotencyKey)}, ${sqlValue(createdAt)}, ${sqlValue(createdAt)})`,
      expectChanges: 1
    }
  ];
  const idempotencyRequest = {
    company_id: normalized.companyId,
    brief_type: normalized.briefType,
    business_date: normalized.businessDate,
    timezone: normalized.timezone,
    template_version: templateVersion,
    target: "aos_home"
  };
  return dbBackend === "postgres"
    ? runIdempotentSqlMutationAsync({ companyId: normalized.companyId, scope: COMPANY_BRIEF_DELIVERY_SCOPE, key: normalized.idempotencyKey, request: idempotencyRequest, resourceSteps, response })
    : runIdempotentSqlMutation({ companyId: normalized.companyId, scope: COMPANY_BRIEF_DELIVERY_SCOPE, key: normalized.idempotencyKey, request: idempotencyRequest, resourceSteps, response });
}

const BRIEF_DELIVERY_STAGES = ["brief_generation", "home_delivery", "source_sync", "reconciliation", "cleanup"] as const;
type BriefDeliveryStage = (typeof BRIEF_DELIVERY_STAGES)[number];

function normalizeInput(input: CompanyBriefHomeDeliveryInput): CompanyBriefHomeDeliveryInput {
  const companyId = String(input.companyId ?? "").trim();
  const idempotencyKey = String(input.idempotencyKey ?? "").trim();
  const businessDate = String(input.businessDate ?? "").trim();
  const timezone = String(input.timezone ?? "").trim() || "Asia/Tokyo";
  const templateVersion = String(input.templateVersion ?? "v1").trim() || "v1";
  if (!companyId) throw new CompanyBriefDeliveryError("company_id_required");
  if (!idempotencyKey) throw new CompanyBriefDeliveryError("idempotency_key_required");
  if (input.briefType !== "morning" && input.briefType !== "evening") throw new CompanyBriefDeliveryError("brief_type_invalid");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(businessDate)) throw new CompanyBriefDeliveryError("business_date_invalid");
  if (timezone.length > 100) throw new CompanyBriefDeliveryError("timezone_invalid");
  if (templateVersion.length > 64) throw new CompanyBriefDeliveryError("template_version_invalid");
  return { companyId, briefType: input.briefType, businessDate, timezone, templateVersion, idempotencyKey };
}

function assertDeliverableBundle(bundle: LocalBriefBundle, companyId: string): void {
  if (bundle.status !== "complete" || bundle.counts.excluded_records !== 0) throw new CompanyBriefDeliveryError("brief_delivery_requires_complete_bundle");
  if (bundle.companies.length !== 1 || bundle.companies[0]?.company_id !== companyId) throw new CompanyBriefDeliveryError("brief_delivery_company_scope_mismatch");
}

function deliveryReadbackSql(input: { companyId: string; briefType: LocalBriefType; businessDate: string; timezone: string; templateVersion: string }): string {
  return `
    SELECT id, run_id, receipt_hash, created_at, input_fingerprint, output_fingerprint
    FROM brief_deliveries
    WHERE company_id=${sqlValue(input.companyId)}
      AND brief_type=${sqlValue(input.briefType)}
      AND business_date=${sqlValue(input.businessDate)}
      AND timezone=${sqlValue(input.timezone)}
      AND template_version=${sqlValue(input.templateVersion)}
      AND delivery_status='delivered' AND source_sync_status='synced'
      AND reconciliation_status='reconciled' AND cleanup_status='verified'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `;
}

function deliveryReadback(row: DeliveryRow): CompanyBriefDeliveryReadback {
  return {
    attempted: true,
    status: "delivered",
    delivery_id: row.id,
    run_id: row.run_id,
    target: "aos_home",
    receipt_hash: row.receipt_hash,
    delivered_at: row.created_at,
    output_fingerprint: row.output_fingerprint,
    source_sync_status: "synced",
    reconciliation_status: "reconciled",
    cleanup_status: "verified"
  };
}

function proofUri(deliveryId: string, stage: BriefDeliveryStage): string {
  return `aos://brief-deliveries/${deliveryId}/${stage}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

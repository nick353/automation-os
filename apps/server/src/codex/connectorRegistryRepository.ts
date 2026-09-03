import { createHash } from "node:crypto";
import {
  makeId,
  nowIso,
  querySql,
  querySqlAsync,
  runSqlTransaction,
  runSqlTransactionAsync,
  sqlValue,
  type SqlTransactionStep
} from "../db/client.js";
import {
  sanitizeZeaburConnectorRegistryReadback,
  ZEABUR_CONNECTOR_REGISTRY_READBACK_SCHEMA,
  type ZeaburConnectorRegistryReadback
} from "./zeaburConnectorRouting.js";

export type CompanyCodexRegistryReadback = {
  id: string;
  companyId: string;
  source: string;
  capturedAt: string;
  registry: ZeaburConnectorRegistryReadback;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export class ConnectorRegistryRepositoryError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "ConnectorRegistryRepositoryError";
  }
}

type RegistryRow = {
  id: string;
  company_id: string;
  source: string;
  captured_at: string;
  registry_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
};

export function getCompanyCodexRegistryReadback(companyId: string): CompanyCodexRegistryReadback | null {
  const row = querySql<RegistryRow>(`
    SELECT id, company_id, source, captured_at, registry_json, revision, created_at, updated_at
    FROM codex_app_server_registry_readbacks
    WHERE company_id=${sqlValue(required(companyId, "company_scope_required"))}
    LIMIT 1
  `)[0];
  return row ? toRecord(row) : null;
}

export async function getCompanyCodexRegistryReadbackAsync(companyId: string): Promise<CompanyCodexRegistryReadback | null> {
  const row = (await querySqlAsync<RegistryRow>(`
    SELECT id, company_id, source, captured_at, registry_json, revision, created_at, updated_at
    FROM codex_app_server_registry_readbacks
    WHERE company_id=${sqlValue(required(companyId, "company_scope_required"))}
    LIMIT 1
  `))[0];
  return row ? toRecord(row) : null;
}

export function saveCompanyCodexRegistryReadback(input: {
  companyId: string;
  registry: unknown;
  actorUserId: string;
}): CompanyCodexRegistryReadback {
  const normalized = normalizeRegistry(input.registry);
  const companyId = required(input.companyId, "company_scope_required");
  const current = getCompanyCodexRegistryReadback(companyId);
  assertFresh(normalized, current);
  const serialized = JSON.stringify(normalized);
  if (current && JSON.stringify(current.registry) === serialized) return current;
  const timestamp = nowIso();
  const nextRevision = current ? current.revision + 1 : 1;
  runSqlTransaction(registrySteps({ companyId, actorUserId: required(input.actorUserId, "actor_user_id_required"), registry: normalized, serialized, current, timestamp, nextRevision }));
  return getCompanyCodexRegistryReadback(companyId)!;
}

export async function saveCompanyCodexRegistryReadbackAsync(input: {
  companyId: string;
  registry: unknown;
  actorUserId: string;
}): Promise<CompanyCodexRegistryReadback> {
  const normalized = normalizeRegistry(input.registry);
  const companyId = required(input.companyId, "company_scope_required");
  const current = await getCompanyCodexRegistryReadbackAsync(companyId);
  assertFresh(normalized, current);
  const serialized = JSON.stringify(normalized);
  if (current && JSON.stringify(current.registry) === serialized) return current;
  const timestamp = nowIso();
  const nextRevision = current ? current.revision + 1 : 1;
  await runSqlTransactionAsync(registrySteps({ companyId, actorUserId: required(input.actorUserId, "actor_user_id_required"), registry: normalized, serialized, current, timestamp, nextRevision }));
  return (await getCompanyCodexRegistryReadbackAsync(companyId))!;
}

export function normalizeCompanyCodexRegistryReadback(value: unknown): ZeaburConnectorRegistryReadback {
  return normalizeRegistry(value);
}

function normalizeRegistry(value: unknown): ZeaburConnectorRegistryReadback {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConnectorRegistryRepositoryError("zeabur_registry_readback_invalid");
  const raw = value as Record<string, unknown>;
  if (raw.schema !== ZEABUR_CONNECTOR_REGISTRY_READBACK_SCHEMA) throw new ConnectorRegistryRepositoryError("zeabur_registry_schema_invalid");
  const registry = sanitizeZeaburConnectorRegistryReadback(raw);
  if (registry.secretMaterialIncluded !== false) throw new ConnectorRegistryRepositoryError("zeabur_registry_secret_material_forbidden");
  if (!Number.isFinite(Date.parse(registry.capturedAt))) throw new ConnectorRegistryRepositoryError("zeabur_registry_captured_at_invalid");
  return registry;
}

function assertFresh(incoming: ZeaburConnectorRegistryReadback, current: CompanyCodexRegistryReadback | null): void {
  if (!current) return;
  if (Date.parse(incoming.capturedAt) < Date.parse(current.capturedAt)) throw new ConnectorRegistryRepositoryError("zeabur_registry_readback_stale");
}

function registrySteps(input: {
  companyId: string;
  actorUserId: string;
  registry: ZeaburConnectorRegistryReadback;
  serialized: string;
  current: CompanyCodexRegistryReadback | null;
  timestamp: string;
  nextRevision: number;
}): SqlTransactionStep[] {
  const digest = createHash("sha256").update(input.serialized, "utf8").digest("hex");
  const id = input.current?.id ?? makeId("codex_registry");
  const rowSql = input.current
    ? `UPDATE codex_app_server_registry_readbacks
       SET source=${sqlValue(input.registry.source)}, captured_at=${sqlValue(input.registry.capturedAt)}, registry_json=${sqlValue(input.serialized)}, revision=${input.nextRevision}, updated_at=${sqlValue(input.timestamp)}
       WHERE id=${sqlValue(id)} AND company_id=${sqlValue(input.companyId)} AND revision=${input.current.revision}`
    : `INSERT INTO codex_app_server_registry_readbacks
       (id, company_id, source, captured_at, registry_json, revision, created_at, updated_at)
       VALUES (${sqlValue(id)}, ${sqlValue(input.companyId)}, ${sqlValue(input.registry.source)}, ${sqlValue(input.registry.capturedAt)}, ${sqlValue(input.serialized)}, ${input.nextRevision}, ${sqlValue(input.timestamp)}, ${sqlValue(input.timestamp)})`;
  return [
    { sql: rowSql, expectChanges: 1 },
    {
      sql: `INSERT INTO company_audit_events
        (id, company_id, actor_user_id, action, entity_type, entity_id, before_json, after_json, created_at)
        VALUES (${sqlValue(makeId("audit"))}, ${sqlValue(input.companyId)}, ${sqlValue(input.actorUserId)}, ${sqlValue(input.current ? "codex_app_server.registry_refreshed" : "codex_app_server.registry_created")}, ${sqlValue("codex_app_server_registry")}, ${sqlValue(id)}, ${sqlValue(input.current ? { revision: input.current.revision, captured_at: input.current.capturedAt } : {})}, ${sqlValue({ revision: input.nextRevision, captured_at: input.registry.capturedAt, source: input.registry.source, registry_sha256: digest, secret_material_included: false })}, ${sqlValue(input.timestamp)})`,
      expectChanges: 1
    }
  ];
}

function toRecord(row: RegistryRow): CompanyCodexRegistryReadback {
  let registry: unknown;
  try { registry = JSON.parse(row.registry_json); } catch { throw new ConnectorRegistryRepositoryError("zeabur_registry_persisted_json_invalid"); }
  return {
    id: row.id,
    companyId: row.company_id,
    source: row.source,
    capturedAt: row.captured_at,
    registry: normalizeRegistry(registry),
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function required(value: string, code: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new ConnectorRegistryRepositoryError(code);
  return normalized;
}

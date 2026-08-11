import { makeId, nowIso, querySql, querySqlAsync, runSqlTransaction, sqlValue, type SqlTransactionStep } from "../db/client.js";
import { requireCompanyAccess } from "../companies/repository.js";
import type {
  AutomationDefinitionInput,
  AutomationPatchInput,
  AutomationScheduleInput,
  CompanyConnectionAccountRefInput,
  CompanyMemoryInput
} from "./contracts.js";
import { runIdempotentSqlMutation } from "./idempotency.js";

export class AutomationRepositoryError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "AutomationRepositoryError";
  }
}

export type AutomationRecord = {
  id: string;
  companyId: string;
  revision: number;
  currentVersionId: string;
  automationType: string;
  name: string;
  description: string;
  goal: string;
  lane: string;
  riskLevel: string;
  approvalPolicy: string;
  workerCommandKind: string;
  createApproval: boolean;
  builderSpec: Record<string, unknown>;
  status: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type AutomationRow = {
  id: string;
  company_id: string;
  revision: number;
  current_version_id: string | null;
  automation_type: string;
  name: string;
  description: string;
  goal: string;
  lane: string;
  risk_level: string;
  approval_policy: string;
  worker_command_kind: string;
  create_approval: number;
  builder_spec_json: string;
  status: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export function listAutomationRecords(companyId: string, includeArchived = false): AutomationRecord[] {
  const company = required(companyId, "company_id_required");
  return querySql<AutomationRow>(`
    SELECT id, company_id, revision, current_version_id, automation_type, name, description, goal, lane,
           risk_level, approval_policy, worker_command_kind, create_approval, builder_spec_json, status,
           archived_at, created_at, updated_at
    FROM mvp_automations
    WHERE company_id=${sqlValue(company)} ${includeArchived ? "" : "AND archived_at IS NULL"}
    ORDER BY updated_at DESC, id ASC
  `).map(toAutomationRecord);
}

export async function listAutomationRecordsAsync(companyId: string, includeArchived = false): Promise<AutomationRecord[]> {
  const company = required(companyId, "company_id_required");
  const rows = await querySqlAsync<AutomationRow>(`
    SELECT id, company_id, revision, current_version_id, automation_type, name, description, goal, lane,
           risk_level, approval_policy, worker_command_kind, create_approval, builder_spec_json, status,
           archived_at, created_at, updated_at
    FROM mvp_automations
    WHERE company_id=${sqlValue(company)} ${includeArchived ? "" : "AND archived_at IS NULL"}
    ORDER BY updated_at DESC, id ASC
  `);
  return rows.map(toAutomationRecord);
}

export function getAutomationRecord(companyId: string, automationId: string, includeArchived = false): AutomationRecord | undefined {
  const company = required(companyId, "company_id_required");
  const id = required(automationId, "automation_id_required");
  const row = querySql<AutomationRow>(`
    SELECT id, company_id, revision, current_version_id, automation_type, name, description, goal, lane,
           risk_level, approval_policy, worker_command_kind, create_approval, builder_spec_json, status,
           archived_at, created_at, updated_at
    FROM mvp_automations
    WHERE id=${sqlValue(id)} AND company_id=${sqlValue(company)} ${includeArchived ? "" : "AND archived_at IS NULL"}
    LIMIT 1
  `)[0];
  return row ? toAutomationRecord(row) : undefined;
}

export type AutomationVersionRecord = Omit<AutomationRecord, "currentVersionId" | "archivedAt"> & {
  versionId: string;
  automationId: string;
};

export function listAutomationVersions(companyId: string, automationId: string): AutomationVersionRecord[] {
  const automation = requiredAutomation(companyId, automationId, true);
  return querySql<any>(`
    SELECT * FROM mvp_automation_versions
    WHERE company_id=${sqlValue(automation.companyId)} AND automation_id=${sqlValue(automation.id)}
    ORDER BY revision DESC
  `).map((row) => ({
    versionId: row.id,
    automationId: row.automation_id,
    id: row.automation_id,
    companyId: row.company_id,
    revision: Number(row.revision),
    automationType: row.automation_type,
    name: row.name,
    description: row.description,
    goal: row.goal,
    lane: row.lane,
    riskLevel: row.risk_level,
    approvalPolicy: row.approval_policy,
    workerCommandKind: row.worker_command_kind,
    createApproval: row.create_approval === 1,
    builderSpec: parseObject(row.builder_spec_json),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

export function createAutomationRecord(input: {
  companyId: string;
  actorUserId: string;
  definition: AutomationDefinitionInput;
  automationId?: string;
  idempotencyKey?: string;
  idempotencyRequest?: unknown;
}): AutomationRecord {
  const companyId = required(input.companyId, "company_id_required");
  const actorUserId = required(input.actorUserId, "actor_user_id_required");
  requireCompanyAccess(companyId, ["owner", "admin", "operator"], actorUserId);
  const automationId = input.automationId ? required(input.automationId, "automation_id_required") : makeId("automation");
  if (!input.idempotencyKey && querySql(`SELECT id FROM mvp_automations WHERE id=${sqlValue(automationId)} LIMIT 1`)[0]) {
    throw new AutomationRepositoryError("automation_id_conflict");
  }
  const timestamp = nowIso();
  const versionId = makeId("automation_version");
  const record = recordFromDefinition({
    id: automationId,
    companyId,
    revision: 1,
    currentVersionId: versionId,
    definition: input.definition,
    status: "draft",
    archivedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp
  });
  const steps = [
    insertAutomationStep(record),
    insertVersionStep(record),
    auditStep(companyId, actorUserId, "automation.created", "automation", automationId, {}, record, timestamp)
  ];
  if (input.idempotencyKey) {
    const result = runIdempotentSqlMutation({
      companyId,
      scope: `automation:create:${actorUserId}`,
      key: input.idempotencyKey,
      request: input.idempotencyRequest ?? input.definition,
      resourceSteps: steps,
      response: { automation_id: automationId, revision: record.revision, current_version_id: versionId }
    });
    return requiredAutomation(companyId, String(result.response.automation_id), true);
  }
  runSqlTransaction(steps);
  return requiredAutomation(companyId, automationId, true);
}

export function updateAutomationRecord(input: {
  companyId: string;
  actorUserId: string;
  automationId: string;
  patch: AutomationPatchInput;
}): AutomationRecord {
  requireCompanyAccess(required(input.companyId, "company_id_required"), ["owner", "admin", "operator"], required(input.actorUserId, "actor_user_id_required"));
  const current = requiredAutomation(input.companyId, input.automationId, true);
  if (current.archivedAt) throw new AutomationRepositoryError("automation_archived");
  if (current.revision !== input.patch.expectedRevision) throw new AutomationRepositoryError("automation_revision_conflict");
  const timestamp = nowIso();
  const next: AutomationRecord = {
    ...current,
    revision: current.revision + 1,
    currentVersionId: makeId("automation_version"),
    automationType: input.patch.automationType ?? current.automationType,
    name: input.patch.name ?? current.name,
    description: input.patch.description ?? current.description,
    goal: input.patch.goal ?? current.goal,
    lane: input.patch.lane ?? current.lane,
    riskLevel: input.patch.riskLevel ?? current.riskLevel,
    approvalPolicy: input.patch.approvalPolicy ?? current.approvalPolicy,
    workerCommandKind: input.patch.workerCommandKind ?? current.workerCommandKind,
    createApproval: input.patch.createApproval ?? current.createApproval,
    builderSpec: input.patch.builderSpec ?? current.builderSpec,
    updatedAt: timestamp
  };
  runSqlTransaction([
    insertVersionStep(next),
    updateAutomationStep(next, current.revision),
    auditStep(next.companyId, required(input.actorUserId, "actor_user_id_required"), "automation.updated", "automation", next.id, current, next, timestamp)
  ]);
  return requiredAutomation(next.companyId, next.id, true);
}

export function activateAutomationRecord(input: {
  companyId: string;
  actorUserId: string;
  automationId: string;
  expectedRevision: number;
}): AutomationRecord {
  requireCompanyAccess(required(input.companyId, "company_id_required"), ["owner", "admin", "operator"], required(input.actorUserId, "actor_user_id_required"));
  const current = requiredAutomation(input.companyId, input.automationId, true);
  if (current.archivedAt) throw new AutomationRepositoryError("automation_archived");
  if (current.revision !== input.expectedRevision) throw new AutomationRepositoryError("automation_revision_conflict");
  if (current.status === "active") return current;
  const timestamp = nowIso();
  const next: AutomationRecord = {
    ...current,
    revision: current.revision + 1,
    currentVersionId: makeId("automation_version"),
    status: "active",
    updatedAt: timestamp
  };
  runSqlTransaction([
    insertVersionStep(next),
    updateAutomationStep(next, current.revision),
    auditStep(next.companyId, required(input.actorUserId, "actor_user_id_required"), "automation.activated", "automation", next.id, current, next, timestamp)
  ]);
  return requiredAutomation(next.companyId, next.id, true);
}

export function archiveAutomationRecord(input: {
  companyId: string;
  actorUserId: string;
  automationId: string;
  expectedRevision: number;
}): AutomationRecord {
  requireCompanyAccess(required(input.companyId, "company_id_required"), ["owner", "admin"], required(input.actorUserId, "actor_user_id_required"));
  const current = requiredAutomation(input.companyId, input.automationId, true);
  if (current.revision !== input.expectedRevision) throw new AutomationRepositoryError("automation_revision_conflict");
  if (current.archivedAt) return current;
  const timestamp = nowIso();
  const next: AutomationRecord = {
    ...current,
    revision: current.revision + 1,
    currentVersionId: makeId("automation_version"),
    status: "archived",
    archivedAt: timestamp,
    updatedAt: timestamp
  };
  runSqlTransaction([
    insertVersionStep(next),
    updateAutomationStep(next, current.revision),
    {
      sql: `UPDATE mvp_automation_schedules
            SET enabled=0, status='paused', paused_at=${sqlValue(timestamp)}, updated_at=${sqlValue(timestamp)}
            WHERE company_id=${sqlValue(next.companyId)} AND automation_id=${sqlValue(next.id)} AND status <> 'paused'`
    },
    auditStep(next.companyId, required(input.actorUserId, "actor_user_id_required"), "automation.archived", "automation", next.id, current, next, timestamp)
  ]);
  return requiredAutomation(next.companyId, next.id, true);
}

export type AutomationScheduleRecord = {
  id: string;
  companyId: string;
  automationId: string;
  automationVersionId: string | null;
  kind: string;
  expression: string | null;
  timezone: string;
  enabled: boolean;
  status: string;
  revision: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  pausedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export function listAutomationSchedules(companyId: string, automationId?: string): AutomationScheduleRecord[] {
  const company = required(companyId, "company_id_required");
  const scopedAutomation = automationId ? ` AND automation_id=${sqlValue(required(automationId, "automation_id_required"))}` : "";
  return querySql<any>(`SELECT * FROM mvp_automation_schedules WHERE company_id=${sqlValue(company)}${scopedAutomation} ORDER BY updated_at DESC`).map(toScheduleRecord);
}

export async function listAutomationSchedulesAsync(companyId: string, automationId?: string): Promise<AutomationScheduleRecord[]> {
  const company = required(companyId, "company_id_required");
  const scopedAutomation = automationId ? ` AND automation_id=${sqlValue(required(automationId, "automation_id_required"))}` : "";
  const rows = await querySqlAsync<any>(`SELECT * FROM mvp_automation_schedules WHERE company_id=${sqlValue(company)}${scopedAutomation} ORDER BY updated_at DESC`);
  return rows.map(toScheduleRecord);
}

export function saveAutomationSchedule(input: {
  companyId: string;
  actorUserId: string;
  automationId: string;
  schedule: AutomationScheduleInput;
  nextRunAt?: string | null;
}): AutomationScheduleRecord {
  requireCompanyAccess(required(input.companyId, "company_id_required"), ["owner", "admin", "operator"], required(input.actorUserId, "actor_user_id_required"));
  const automation = requiredAutomation(input.companyId, input.automationId, false);
  const existing = listAutomationSchedules(automation.companyId, automation.id)[0];
  if (existing && existing.revision !== input.schedule.expectedRevision) throw new AutomationRepositoryError("automation_schedule_revision_conflict");
  if (!existing && input.schedule.expectedRevision !== 1) throw new AutomationRepositoryError("automation_schedule_revision_conflict");
  const timestamp = nowIso();
  const next: AutomationScheduleRecord = {
    id: existing?.id ?? makeId("automation_schedule"),
    companyId: automation.companyId,
    automationId: automation.id,
    automationVersionId: automation.currentVersionId,
    kind: input.schedule.kind,
    expression: input.schedule.expression,
    timezone: input.schedule.timezone,
    enabled: input.schedule.enabled,
    status: input.schedule.enabled ? "active" : "paused",
    revision: existing ? existing.revision + 1 : 1,
    nextRunAt: input.nextRunAt ?? null,
    lastRunAt: existing?.lastRunAt ?? null,
    pausedAt: input.schedule.enabled ? null : timestamp,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp
  };
  const mutation = existing ? updateScheduleStep(next, existing.revision) : insertScheduleStep(next);
  runSqlTransaction([
    mutation,
    auditStep(next.companyId, required(input.actorUserId, "actor_user_id_required"), existing ? "automation.schedule_updated" : "automation.schedule_created", "automation_schedule", next.id, existing ?? {}, next, timestamp)
  ]);
  return listAutomationSchedules(next.companyId, next.automationId).find((item) => item.id === next.id)!;
}

export function setAutomationSchedulePaused(input: {
  companyId: string;
  actorUserId: string;
  automationId: string;
  scheduleId: string;
  expectedRevision: number;
  paused: boolean;
}): AutomationScheduleRecord {
  requireCompanyAccess(required(input.companyId, "company_id_required"), ["owner", "admin", "operator"], required(input.actorUserId, "actor_user_id_required"));
  requiredAutomation(input.companyId, input.automationId, false);
  const current = listAutomationSchedules(input.companyId, input.automationId).find((item) => item.id === input.scheduleId);
  if (!current) throw new AutomationRepositoryError("automation_schedule_not_found");
  if (current.revision !== input.expectedRevision) throw new AutomationRepositoryError("automation_schedule_revision_conflict");
  const timestamp = nowIso();
  const next = { ...current, revision: current.revision + 1, enabled: !input.paused, status: input.paused ? "paused" : "active", nextRunAt: input.paused ? current.nextRunAt : null, pausedAt: input.paused ? timestamp : null, updatedAt: timestamp };
  runSqlTransaction([
    updateScheduleStep(next, current.revision),
    auditStep(next.companyId, required(input.actorUserId, "actor_user_id_required"), input.paused ? "automation.schedule_paused" : "automation.schedule_resumed", "automation_schedule", next.id, current, next, timestamp)
  ]);
  return listAutomationSchedules(next.companyId, next.automationId).find((item) => item.id === next.id)!;
}

export type CompanyMemoryRecord = { id: string; companyId: string; key: string; kind: string; title: string; body: string; revision: number; status: string; archivedAt: string | null; createdAt: string; updatedAt: string };

export function listCompanyMemory(companyId: string): CompanyMemoryRecord[] {
  return querySql<any>(`SELECT * FROM company_memory_entries WHERE company_id=${sqlValue(required(companyId, "company_id_required"))} AND status='active' ORDER BY memory_key ASC`).map(toMemoryRecord);
}

export function saveCompanyMemory(input: { companyId: string; actorUserId: string; memory: CompanyMemoryInput }): CompanyMemoryRecord {
  const companyId = required(input.companyId, "company_id_required");
  requireCompanyAccess(companyId, ["owner", "admin", "operator"], required(input.actorUserId, "actor_user_id_required"));
  const current = querySql<any>(`SELECT * FROM company_memory_entries WHERE company_id=${sqlValue(companyId)} AND memory_key=${sqlValue(input.memory.key)} LIMIT 1`)[0];
  const existing = current ? toMemoryRecord(current) : undefined;
  if (existing && input.memory.expectedRevision !== existing.revision) throw new AutomationRepositoryError("company_memory_revision_conflict");
  if (!existing && input.memory.expectedRevision !== null) throw new AutomationRepositoryError("company_memory_revision_conflict");
  const timestamp = nowIso();
  const next: CompanyMemoryRecord = { id: existing?.id ?? makeId("company_memory"), companyId, key: input.memory.key, kind: input.memory.kind, title: input.memory.title, body: input.memory.body, revision: existing ? existing.revision + 1 : 1, status: "active", archivedAt: null, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp };
  runSqlTransaction([
    existing ? updateMemoryStep(next, existing.revision) : insertMemoryStep(next),
    auditStep(companyId, required(input.actorUserId, "actor_user_id_required"), existing ? "company_memory.updated" : "company_memory.created", "company_memory", next.id, existing ?? {}, next, timestamp)
  ]);
  return listCompanyMemory(companyId).find((item) => item.id === next.id)!;
}

export type CompanyConnectionRefRecord = { id: string; companyId: string; platform: string; accountRef: string; status: string; scopes: string[]; expiresAt: string | null; oauthState: string; verificationStatus: string; lastVerifiedAt: string | null; reconnectRequestedAt: string | null; revokedAt: string | null; revision: number; createdAt: string; updatedAt: string };

export function listCompanyConnectionRefs(companyId: string): CompanyConnectionRefRecord[] {
  return querySql<any>(`SELECT * FROM company_connection_account_refs WHERE company_id=${sqlValue(required(companyId, "company_id_required"))} ORDER BY platform, account_ref`).map(toConnectionRefRecord);
}

export function saveCompanyConnectionRef(input: { companyId: string; actorUserId: string; connection: CompanyConnectionAccountRefInput }): CompanyConnectionRefRecord {
  const companyId = required(input.companyId, "company_id_required");
  requireCompanyAccess(companyId, ["owner", "admin"], required(input.actorUserId, "actor_user_id_required"));
  const current = querySql<any>(`SELECT * FROM company_connection_account_refs WHERE company_id=${sqlValue(companyId)} AND platform=${sqlValue(input.connection.platform)} AND account_ref=${sqlValue(input.connection.accountRef)} LIMIT 1`)[0];
  const existing = current ? toConnectionRefRecord(current) : undefined;
  if (existing && input.connection.expectedRevision !== existing.revision) throw new AutomationRepositoryError("company_connection_ref_revision_conflict");
  if (!existing && input.connection.expectedRevision !== null) throw new AutomationRepositoryError("company_connection_ref_revision_conflict");
  const timestamp = nowIso();
  if (existing?.status === "revoked") throw new AutomationRepositoryError("company_connection_ref_reconnect_action_required");
  if (input.connection.expiresAt && Date.parse(input.connection.expiresAt) <= Date.parse(timestamp)) {
    throw new AutomationRepositoryError("company_connection_ref_expired");
  }
  const next: CompanyConnectionRefRecord = { id: existing?.id ?? makeId("company_connection"), companyId, platform: input.connection.platform, accountRef: input.connection.accountRef, status: input.connection.status, scopes: input.connection.scopes, expiresAt: input.connection.expiresAt, oauthState: input.connection.oauthState, verificationStatus: input.connection.verificationStatus, lastVerifiedAt: input.connection.lastVerifiedAt, reconnectRequestedAt: existing?.reconnectRequestedAt ?? null, revokedAt: input.connection.status === "revoked" ? timestamp : null, revision: existing ? existing.revision + 1 : 1, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp };
  runSqlTransaction([
    existing ? updateConnectionStep(next, existing.revision) : insertConnectionStep(next),
    auditStep(companyId, required(input.actorUserId, "actor_user_id_required"), existing ? "company_connection.updated" : "company_connection.created", "company_connection", next.id, existing ?? {}, next, timestamp)
  ]);
  return listCompanyConnectionRefs(companyId).find((item) => item.id === next.id)!;
}

export function requestCompanyConnectionReconnect(input: { companyId: string; actorUserId: string; connectionId: string; expectedRevision: number }): CompanyConnectionRefRecord {
  requireCompanyAccess(required(input.companyId, "company_id_required"), ["owner", "admin"], required(input.actorUserId, "actor_user_id_required"));
  const current = requiredConnectionRef(input.companyId, input.connectionId);
  if (current.revision !== input.expectedRevision) throw new AutomationRepositoryError("company_connection_ref_revision_conflict");
  const timestamp = nowIso();
  const next: CompanyConnectionRefRecord = { ...current, status: "reconnect_required", oauthState: "reauthorization_required", verificationStatus: "unverified", reconnectRequestedAt: timestamp, revokedAt: null, revision: current.revision + 1, updatedAt: timestamp };
  runSqlTransaction([
    updateConnectionStep(next, current.revision),
    auditStep(next.companyId, required(input.actorUserId, "actor_user_id_required"), "company_connection.reconnect_requested", "company_connection", next.id, current, next, timestamp)
  ]);
  return requiredConnectionRef(next.companyId, next.id);
}

export function revokeCompanyConnectionRef(input: { companyId: string; actorUserId: string; connectionId: string; expectedRevision: number }): CompanyConnectionRefRecord {
  requireCompanyAccess(required(input.companyId, "company_id_required"), ["owner", "admin"], required(input.actorUserId, "actor_user_id_required"));
  const current = requiredConnectionRef(input.companyId, input.connectionId);
  if (current.revision !== input.expectedRevision) throw new AutomationRepositoryError("company_connection_ref_revision_conflict");
  const timestamp = nowIso();
  const next: CompanyConnectionRefRecord = { ...current, status: "revoked", oauthState: "revoked", verificationStatus: "unverified", reconnectRequestedAt: null, revokedAt: timestamp, revision: current.revision + 1, updatedAt: timestamp };
  runSqlTransaction([
    updateConnectionStep(next, current.revision),
    auditStep(next.companyId, required(input.actorUserId, "actor_user_id_required"), "company_connection.revoked", "company_connection", next.id, current, next, timestamp)
  ]);
  return requiredConnectionRef(next.companyId, next.id);
}

function requiredAutomation(companyId: string, automationId: string, includeArchived: boolean): AutomationRecord {
  const found = getAutomationRecord(companyId, automationId, includeArchived);
  if (!found) throw new AutomationRepositoryError("automation_not_found");
  return found;
}

function toAutomationRecord(row: AutomationRow): AutomationRecord {
  return { id: row.id, companyId: row.company_id, revision: Number(row.revision), currentVersionId: row.current_version_id ?? "", automationType: row.automation_type, name: row.name, description: row.description, goal: row.goal, lane: row.lane, riskLevel: row.risk_level, approvalPolicy: row.approval_policy, workerCommandKind: row.worker_command_kind, createApproval: row.create_approval === 1, builderSpec: parseObject(row.builder_spec_json), status: row.status, archivedAt: row.archived_at, createdAt: row.created_at, updatedAt: row.updated_at };
}

function recordFromDefinition(input: { id: string; companyId: string; revision: number; currentVersionId: string; definition: AutomationDefinitionInput; status: string; archivedAt: string | null; createdAt: string; updatedAt: string }): AutomationRecord {
  return { id: input.id, companyId: input.companyId, revision: input.revision, currentVersionId: input.currentVersionId, automationType: input.definition.automationType, name: input.definition.name, description: input.definition.description, goal: input.definition.goal, lane: input.definition.lane, riskLevel: input.definition.riskLevel, approvalPolicy: input.definition.approvalPolicy, workerCommandKind: input.definition.workerCommandKind, createApproval: input.definition.createApproval, builderSpec: input.definition.builderSpec, status: input.status, archivedAt: input.archivedAt, createdAt: input.createdAt, updatedAt: input.updatedAt };
}

function insertAutomationStep(record: AutomationRecord): SqlTransactionStep {
  return { sql: `INSERT INTO mvp_automations (id, company_id, project_id, automation_type, name, description, "desc", goal, schedule, cadence, lane, risk_level, approval_policy, worker_command_kind, create_approval, status, builder_spec_json, current_version_id, revision, archived_at, created_at, updated_at) VALUES (${sqlValue(record.id)}, ${sqlValue(record.companyId)}, ${sqlValue(record.companyId)}, ${sqlValue(record.automationType)}, ${sqlValue(record.name)}, ${sqlValue(record.description)}, ${sqlValue(record.description)}, ${sqlValue(record.goal)}, 'manual', 'manual', ${sqlValue(record.lane)}, ${sqlValue(record.riskLevel)}, ${sqlValue(record.approvalPolicy)}, ${sqlValue(record.workerCommandKind)}, ${record.createApproval ? 1 : 0}, ${sqlValue(record.status)}, ${sqlValue(record.builderSpec)}, ${sqlValue(record.currentVersionId)}, ${record.revision}, ${sqlValue(record.archivedAt)}, ${sqlValue(record.createdAt)}, ${sqlValue(record.updatedAt)})`, expectChanges: 1 };
}

function insertVersionStep(record: AutomationRecord): SqlTransactionStep {
  return { sql: `INSERT INTO mvp_automation_versions (id, company_id, project_id, automation_id, revision, automation_type, name, description, goal, schedule, cadence, lane, risk_level, approval_policy, worker_command_kind, create_approval, status, builder_spec_json, created_at, updated_at) VALUES (${sqlValue(record.currentVersionId)}, ${sqlValue(record.companyId)}, ${sqlValue(record.companyId)}, ${sqlValue(record.id)}, ${record.revision}, ${sqlValue(record.automationType)}, ${sqlValue(record.name)}, ${sqlValue(record.description)}, ${sqlValue(record.goal)}, 'manual', 'manual', ${sqlValue(record.lane)}, ${sqlValue(record.riskLevel)}, ${sqlValue(record.approvalPolicy)}, ${sqlValue(record.workerCommandKind)}, ${record.createApproval ? 1 : 0}, ${sqlValue(record.status)}, ${sqlValue(record.builderSpec)}, ${sqlValue(record.updatedAt)}, ${sqlValue(record.updatedAt)})`, expectChanges: 1 };
}

function updateAutomationStep(record: AutomationRecord, expectedRevision: number): SqlTransactionStep {
  return { sql: `UPDATE mvp_automations SET automation_type=${sqlValue(record.automationType)}, name=${sqlValue(record.name)}, description=${sqlValue(record.description)}, "desc"=${sqlValue(record.description)}, goal=${sqlValue(record.goal)}, lane=${sqlValue(record.lane)}, risk_level=${sqlValue(record.riskLevel)}, approval_policy=${sqlValue(record.approvalPolicy)}, worker_command_kind=${sqlValue(record.workerCommandKind)}, create_approval=${record.createApproval ? 1 : 0}, status=${sqlValue(record.status)}, builder_spec_json=${sqlValue(record.builderSpec)}, current_version_id=${sqlValue(record.currentVersionId)}, revision=${record.revision}, archived_at=${sqlValue(record.archivedAt)}, updated_at=${sqlValue(record.updatedAt)} WHERE id=${sqlValue(record.id)} AND company_id=${sqlValue(record.companyId)} AND revision=${expectedRevision}`, expectChanges: 1 };
}

function insertScheduleStep(row: AutomationScheduleRecord): SqlTransactionStep { return { sql: `INSERT INTO mvp_automation_schedules (id, company_id, project_id, automation_id, automation_version_id, kind, expression, timezone, enabled, status, revision, next_run_at, last_run_at, paused_at, created_at, updated_at) VALUES (${sqlValue(row.id)}, ${sqlValue(row.companyId)}, ${sqlValue(row.companyId)}, ${sqlValue(row.automationId)}, ${sqlValue(row.automationVersionId)}, ${sqlValue(row.kind)}, ${sqlValue(row.expression)}, ${sqlValue(row.timezone)}, ${row.enabled ? 1 : 0}, ${sqlValue(row.status)}, ${row.revision}, ${sqlValue(row.nextRunAt)}, ${sqlValue(row.lastRunAt)}, ${sqlValue(row.pausedAt)}, ${sqlValue(row.createdAt)}, ${sqlValue(row.updatedAt)})`, expectChanges: 1 }; }
function updateScheduleStep(row: AutomationScheduleRecord, expectedRevision: number): SqlTransactionStep { return { sql: `UPDATE mvp_automation_schedules SET automation_version_id=${sqlValue(row.automationVersionId)}, kind=${sqlValue(row.kind)}, expression=${sqlValue(row.expression)}, timezone=${sqlValue(row.timezone)}, enabled=${row.enabled ? 1 : 0}, status=${sqlValue(row.status)}, revision=${row.revision}, next_run_at=${sqlValue(row.nextRunAt)}, last_run_at=${sqlValue(row.lastRunAt)}, paused_at=${sqlValue(row.pausedAt)}, updated_at=${sqlValue(row.updatedAt)} WHERE id=${sqlValue(row.id)} AND company_id=${sqlValue(row.companyId)} AND automation_id=${sqlValue(row.automationId)} AND revision=${expectedRevision}`, expectChanges: 1 }; }
function toScheduleRecord(row: any): AutomationScheduleRecord { return { id: row.id, companyId: row.company_id, automationId: row.automation_id, automationVersionId: row.automation_version_id, kind: row.kind, expression: row.expression, timezone: row.timezone, enabled: row.enabled === 1, status: row.status, revision: Number(row.revision), nextRunAt: row.next_run_at, lastRunAt: row.last_run_at, pausedAt: row.paused_at, createdAt: row.created_at, updatedAt: row.updated_at }; }

function insertMemoryStep(row: CompanyMemoryRecord): SqlTransactionStep { return { sql: `INSERT INTO company_memory_entries (id, company_id, memory_key, kind, title, body, revision, status, archived_at, created_at, updated_at) VALUES (${sqlValue(row.id)}, ${sqlValue(row.companyId)}, ${sqlValue(row.key)}, ${sqlValue(row.kind)}, ${sqlValue(row.title)}, ${sqlValue(row.body)}, ${row.revision}, ${sqlValue(row.status)}, NULL, ${sqlValue(row.createdAt)}, ${sqlValue(row.updatedAt)})`, expectChanges: 1 }; }
function updateMemoryStep(row: CompanyMemoryRecord, expectedRevision: number): SqlTransactionStep { return { sql: `UPDATE company_memory_entries SET kind=${sqlValue(row.kind)}, title=${sqlValue(row.title)}, body=${sqlValue(row.body)}, revision=${row.revision}, status=${sqlValue(row.status)}, archived_at=${sqlValue(row.archivedAt)}, updated_at=${sqlValue(row.updatedAt)} WHERE id=${sqlValue(row.id)} AND company_id=${sqlValue(row.companyId)} AND revision=${expectedRevision}`, expectChanges: 1 }; }
function toMemoryRecord(row: any): CompanyMemoryRecord { return { id: row.id, companyId: row.company_id, key: row.memory_key, kind: row.kind, title: row.title, body: row.body, revision: Number(row.revision), status: row.status, archivedAt: row.archived_at, createdAt: row.created_at, updatedAt: row.updated_at }; }

function insertConnectionStep(row: CompanyConnectionRefRecord): SqlTransactionStep { return { sql: `INSERT INTO company_connection_account_refs (id, company_id, platform, account_ref, status, scopes_json, expires_at, oauth_state, verification_status, last_verified_at, reconnect_requested_at, revoked_at, revision, created_at, updated_at) VALUES (${sqlValue(row.id)}, ${sqlValue(row.companyId)}, ${sqlValue(row.platform)}, ${sqlValue(row.accountRef)}, ${sqlValue(row.status)}, ${sqlValue(row.scopes)}, ${sqlValue(row.expiresAt)}, ${sqlValue(row.oauthState)}, ${sqlValue(row.verificationStatus)}, ${sqlValue(row.lastVerifiedAt)}, ${sqlValue(row.reconnectRequestedAt)}, ${sqlValue(row.revokedAt)}, ${row.revision}, ${sqlValue(row.createdAt)}, ${sqlValue(row.updatedAt)})`, expectChanges: 1 }; }
function updateConnectionStep(row: CompanyConnectionRefRecord, expectedRevision: number): SqlTransactionStep { return { sql: `UPDATE company_connection_account_refs SET status=${sqlValue(row.status)}, scopes_json=${sqlValue(row.scopes)}, expires_at=${sqlValue(row.expiresAt)}, oauth_state=${sqlValue(row.oauthState)}, verification_status=${sqlValue(row.verificationStatus)}, last_verified_at=${sqlValue(row.lastVerifiedAt)}, reconnect_requested_at=${sqlValue(row.reconnectRequestedAt)}, revoked_at=${sqlValue(row.revokedAt)}, revision=${row.revision}, updated_at=${sqlValue(row.updatedAt)} WHERE id=${sqlValue(row.id)} AND company_id=${sqlValue(row.companyId)} AND revision=${expectedRevision}`, expectChanges: 1 }; }
function toConnectionRefRecord(row: any): CompanyConnectionRefRecord { return { id: row.id, companyId: row.company_id, platform: row.platform, accountRef: row.account_ref, status: row.status, scopes: parseArray(row.scopes_json), expiresAt: row.expires_at, oauthState: row.oauth_state ?? "not_configured", verificationStatus: row.verification_status ?? "unverified", lastVerifiedAt: row.last_verified_at ?? null, reconnectRequestedAt: row.reconnect_requested_at ?? null, revokedAt: row.revoked_at ?? null, revision: Number(row.revision), createdAt: row.created_at, updatedAt: row.updated_at }; }

function requiredConnectionRef(companyId: string, connectionId: string): CompanyConnectionRefRecord {
  const row = querySql<any>(`SELECT * FROM company_connection_account_refs WHERE company_id=${sqlValue(required(companyId, "company_id_required"))} AND id=${sqlValue(required(connectionId, "company_connection_ref_id_required"))} LIMIT 1`)[0];
  if (!row) throw new AutomationRepositoryError("company_connection_ref_not_found");
  return toConnectionRefRecord(row);
}

function auditStep(companyId: string, actorUserId: string, action: string, entityType: string, entityId: string, before: object, after: object, createdAt: string): SqlTransactionStep {
  return { sql: `INSERT INTO company_audit_events (id, company_id, actor_user_id, action, entity_type, entity_id, before_json, after_json, created_at) VALUES (${sqlValue(makeId("audit"))}, ${sqlValue(companyId)}, ${sqlValue(actorUserId)}, ${sqlValue(action)}, ${sqlValue(entityType)}, ${sqlValue(entityId)}, ${sqlValue(before)}, ${sqlValue(after)}, ${sqlValue(createdAt)})`, expectChanges: 1 };
}

function parseObject(value: string): Record<string, unknown> { try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; } }
function parseArray(value: string): string[] { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []; } catch { return []; } }
function required(value: string, code: string): string { const normalized = typeof value === "string" ? value.trim() : ""; if (!normalized) throw new AutomationRepositoryError(code); return normalized; }

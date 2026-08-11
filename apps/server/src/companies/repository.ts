import { createHash } from "node:crypto";
import { execSql, insert, makeId, nowIso, querySql, querySqlAsync, runSqlTransaction, sqlValue, type SqlTransactionStep } from "../db/client.js";
import { requireIdempotencyKey } from "../automations/contracts.js";
import { canonicalJson, hashIdempotencyRequest, readIdempotencyReplay } from "../automations/idempotency.js";

export const companyRoles = ["owner", "admin", "operator", "approver", "viewer"] as const;
export type CompanyRole = (typeof companyRoles)[number];

export type CompanyAccess = {
  id: string;
  slug: string;
  name: string;
  status: string;
  role: CompanyRole;
  created_at: string;
  updated_at: string;
};

const bootstrappedActors = new Set<string>();

export function currentActorUserId(): string {
  const configured = process.env.AUTOMATION_OS_OWNER_USER_ID?.trim();
  return configured || "user_local_owner";
}

export function ensureOwnerShellActor(actorUserId = currentActorUserId()): void {
  if (bootstrappedActors.has(actorUserId)) return;
  const timestamp = nowIso();
  const existing = querySql<{ id: string }>(`SELECT id FROM users WHERE id=${sqlValue(actorUserId)} LIMIT 1`)[0];
  if (!existing) {
    insert("users", {
      id: actorUserId,
      auth_provider: "legacy_operator_token",
      auth_subject: actorUserId,
      email: null,
      display_name: process.env.AUTOMATION_OS_OWNER_DISPLAY_NAME?.trim() || "Automation OS Owner",
      kind: "human",
      status: "active",
      created_at: timestamp,
      updated_at: timestamp
    });
  }

  backfillLegacyCompanies(actorUserId, timestamp);
  bootstrappedActors.add(actorUserId);
}

export function listActorCompanies(actorUserId = currentActorUserId()): CompanyAccess[] {
  ensureOwnerShellActor(actorUserId);
  return querySql<CompanyAccess>(`
    SELECT companies.id, companies.slug, companies.name, companies.status,
           company_memberships.role, companies.created_at, companies.updated_at
    FROM company_memberships
    JOIN companies ON companies.id=company_memberships.company_id
    JOIN users ON users.id=company_memberships.user_id
    WHERE company_memberships.user_id=${sqlValue(actorUserId)}
      AND company_memberships.status='active'
      AND companies.status!='archived'
      AND users.status='active'
    ORDER BY lower(companies.name), companies.id
  `);
}

export async function listActorCompaniesAsync(actorUserId = currentActorUserId()): Promise<CompanyAccess[]> {
  return querySqlAsync<CompanyAccess>(`
    SELECT companies.id, companies.slug, companies.name, companies.status,
           company_memberships.role, companies.created_at, companies.updated_at
    FROM company_memberships
    JOIN companies ON companies.id=company_memberships.company_id
    JOIN users ON users.id=company_memberships.user_id
    WHERE company_memberships.user_id=${sqlValue(actorUserId)}
      AND company_memberships.status='active'
      AND companies.status!='archived'
      AND users.status='active'
    ORDER BY lower(companies.name), companies.id
  `);
}

export function requireCompanyAccess(
  companyId: string,
  allowedRoles: readonly CompanyRole[] = companyRoles,
  actorUserId = currentActorUserId()
): CompanyAccess {
  if (!companyId.trim()) throw new Error("company_scope_required");
  const company = listActorCompanies(actorUserId).find((item) => item.id === companyId);
  if (!company || !allowedRoles.includes(company.role)) throw new Error("company_scope_forbidden");
  return company;
}

export async function requireCompanyAccessAsync(
  companyId: string,
  allowedRoles: readonly CompanyRole[] = companyRoles,
  actorUserId = currentActorUserId()
): Promise<CompanyAccess> {
  if (!companyId.trim()) throw new Error("company_scope_required");
  const company = (await querySqlAsync<CompanyAccess>(`
    SELECT companies.id, companies.slug, companies.name, companies.status,
           company_memberships.role, companies.created_at, companies.updated_at
    FROM company_memberships
    JOIN companies ON companies.id=company_memberships.company_id
    JOIN users ON users.id=company_memberships.user_id
    WHERE company_memberships.company_id=${sqlValue(companyId)}
      AND company_memberships.user_id=${sqlValue(actorUserId)}
      AND company_memberships.status='active'
      AND companies.status!='archived'
      AND users.status='active'
    LIMIT 1
  `))[0];
  if (!company || !allowedRoles.includes(company.role)) throw new Error("company_scope_forbidden");
  return company;
}

export function requireExistingCompanyAccess(
  companyId: string,
  allowedRoles: readonly CompanyRole[],
  actorUserId: string
): CompanyAccess {
  if (!companyId.trim() || !actorUserId.trim()) throw new Error("company_scope_forbidden");
  const company = querySql<CompanyAccess>(`
    SELECT companies.id, companies.slug, companies.name, companies.status,
           company_memberships.role, companies.created_at, companies.updated_at
    FROM company_memberships
    JOIN companies ON companies.id=company_memberships.company_id
    JOIN users ON users.id=company_memberships.user_id
    WHERE company_memberships.company_id=${sqlValue(companyId)}
      AND company_memberships.user_id=${sqlValue(actorUserId)}
      AND company_memberships.status='active'
      AND companies.status!='archived'
      AND users.status='active'
      AND users.kind='service'
    LIMIT 1
  `)[0];
  if (!company || !allowedRoles.includes(company.role)) throw new Error("company_scope_forbidden");
  return company;
}

export function requireExistingServiceIdentity(actorUserId: string): void {
  if (!actorUserId.trim()) throw new Error("service_identity_missing");
  const user = querySql<{ id: string }>(`
    SELECT id FROM users
    WHERE id=${sqlValue(actorUserId)}
      AND status='active'
      AND kind='service'
    LIMIT 1
  `)[0];
  if (!user) throw new Error("service_identity_invalid");
}

export function ensureCompanyServiceIdentity(input: { companyId: string; actorUserId?: string }): { userId: string; companyId: string; role: "operator" } {
  const actorUserId = input.actorUserId ?? currentActorUserId();
  const company = requireCompanyAccess(input.companyId, ["owner", "admin"], actorUserId);
  const userId = `aos_service_${createHash("sha256").update(company.id, "utf8").digest("hex").slice(0, 20)}`;
  const timestamp = nowIso();
  const existingUser = querySql<{ id: string; kind: string; status: string }>(`SELECT id, kind, status FROM users WHERE id=${sqlValue(userId)} LIMIT 1`)[0];
  if (existingUser && (existingUser.kind !== "service" || existingUser.status !== "active")) throw new Error("service_identity_conflict");
  const existingMembership = querySql<{ role: string; status: string }>(`SELECT role, status FROM company_memberships WHERE company_id=${sqlValue(company.id)} AND user_id=${sqlValue(userId)} LIMIT 1`)[0];
  if (existingMembership && (existingMembership.role !== "operator" || existingMembership.status !== "active")) throw new Error("service_identity_membership_conflict");
  const steps: SqlTransactionStep[] = [];
  if (!existingUser) {
    steps.push({
      sql: `INSERT INTO users (id, auth_provider, auth_subject, email, display_name, kind, status, created_at, updated_at)
            VALUES (${sqlValue(userId)}, 'automation_os', ${sqlValue(userId)}, NULL, ${sqlValue(`${company.name} AOS Service`)}, 'service', 'active', ${sqlValue(timestamp)}, ${sqlValue(timestamp)})`,
      expectChanges: 1
    });
  }
  if (!existingMembership) {
    steps.push({
      sql: `INSERT INTO company_memberships (id, company_id, user_id, role, status, created_at, updated_at)
            VALUES (${sqlValue(makeId("membership"))}, ${sqlValue(company.id)}, ${sqlValue(userId)}, 'operator', 'active', ${sqlValue(timestamp)}, ${sqlValue(timestamp)})`,
      expectChanges: 1
    });
  }
  if (steps.length > 0) {
    steps.push({
      sql: `INSERT INTO company_audit_events (id, company_id, actor_user_id, action, entity_type, entity_id, before_json, after_json, created_at)
            VALUES (${sqlValue(makeId("audit"))}, ${sqlValue(company.id)}, ${sqlValue(actorUserId)}, 'service_identity.created_or_reconciled', 'service_identity', ${sqlValue(userId)}, '{}', ${sqlValue({ user_id: userId, role: "operator", secret_material_included: false })}, ${sqlValue(timestamp)})`,
      expectChanges: 1
    });
    runSqlTransaction(steps);
  }
  return { userId, companyId: company.id, role: "operator" };
}

export function createCompanyForActor(input: { name?: unknown; slug?: unknown }, actorUserId = currentActorUserId(), idempotencyKey?: string): CompanyAccess {
  ensureOwnerShellActor(actorUserId);
  const activeActor = querySql<{ id: string }>(`
    SELECT id FROM users
    WHERE id=${sqlValue(actorUserId)} AND status='active' AND kind='human'
    LIMIT 1
  `)[0];
  if (!activeActor) throw new Error("company_scope_forbidden");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new Error("company_name_required");
  if (name.length > 120) throw new Error("company_name_too_long");
  const normalizedIdempotencyKey = idempotencyKey ? requireIdempotencyKey(idempotencyKey) : "";
  const companyId = normalizedIdempotencyKey
    ? `company_${hashIdempotencyRequest({ actorUserId, key: normalizedIdempotencyKey }).slice(0, 24)}`
    : makeId("company");
  const slug = normalizeCompanySlug(typeof input.slug === "string" ? input.slug : name) || companyId;
  const idempotencyScope = "company.create";
  const idempotencyRequest = { name, slug };
  if (normalizedIdempotencyKey) {
    const replay = readIdempotencyReplay<CompanyAccess>({
      companyId,
      scope: idempotencyScope,
      key: normalizedIdempotencyKey,
      request: idempotencyRequest
    });
    if (replay) return replay;
  }
  if (querySql(`SELECT id FROM companies WHERE slug=${sqlValue(slug)} LIMIT 1`)[0]) throw new Error("company_slug_conflict");

  const timestamp = nowIso();
  const membershipId = makeId("membership");
  const auditId = makeId("audit");
  const company: CompanyAccess = { id: companyId, slug, name, status: "active", role: "owner", created_at: timestamp, updated_at: timestamp };
  if (normalizedIdempotencyKey) {
    const idempotencyId = makeId("idempotency");
    const requestHash = hashIdempotencyRequest(idempotencyRequest);
    const transactionSteps: SqlTransactionStep[] = [
      {
        sql: `INSERT INTO companies (id, slug, name, status, created_at, updated_at)
              VALUES (${sqlValue(companyId)}, ${sqlValue(slug)}, ${sqlValue(name)}, 'active', ${sqlValue(timestamp)}, ${sqlValue(timestamp)})`,
        expectChanges: 1
      },
      {
        sql: `INSERT INTO company_memberships (id, company_id, user_id, role, status, created_at, updated_at)
              VALUES (${sqlValue(membershipId)}, ${sqlValue(companyId)}, ${sqlValue(actorUserId)}, 'owner', 'active', ${sqlValue(timestamp)}, ${sqlValue(timestamp)})`,
        expectChanges: 1
      },
      {
        sql: `INSERT INTO company_audit_events (id, company_id, actor_user_id, action, entity_type, entity_id, before_json, after_json, created_at)
              VALUES (${sqlValue(auditId)}, ${sqlValue(companyId)}, ${sqlValue(actorUserId)}, 'company.created', 'company', ${sqlValue(companyId)}, '{}', ${sqlValue(JSON.stringify({ name, slug, status: "active" }))}, ${sqlValue(timestamp)})`,
        expectChanges: 1
      },
      {
        sql: `INSERT INTO mvp_idempotency_keys
              (id, company_id, scope, idempotency_key, request_hash, response_json, status, expires_at, created_at, updated_at)
              VALUES (${sqlValue(idempotencyId)}, ${sqlValue(companyId)}, ${sqlValue(idempotencyScope)}, ${sqlValue(normalizedIdempotencyKey)}, ${sqlValue(requestHash)}, ${sqlValue(canonicalJson(company))}, 'completed', NULL, ${sqlValue(timestamp)}, ${sqlValue(timestamp)})`,
        expectChanges: 1
      }
    ];
    try {
      runSqlTransaction(transactionSteps);
      return company;
    } catch (error) {
      const replay = readIdempotencyReplay<CompanyAccess>({
        companyId,
        scope: idempotencyScope,
        key: normalizedIdempotencyKey,
        request: idempotencyRequest
      });
      if (replay) return replay;
      throw error;
    }
  }
  execSql(`
    BEGIN;
    INSERT INTO companies (id, slug, name, status, created_at, updated_at)
    VALUES (${sqlValue(companyId)}, ${sqlValue(slug)}, ${sqlValue(name)}, 'active', ${sqlValue(timestamp)}, ${sqlValue(timestamp)});
    INSERT INTO company_memberships (id, company_id, user_id, role, status, created_at, updated_at)
    VALUES (${sqlValue(membershipId)}, ${sqlValue(companyId)}, ${sqlValue(actorUserId)}, 'owner', 'active', ${sqlValue(timestamp)}, ${sqlValue(timestamp)});
    INSERT INTO company_audit_events (id, company_id, actor_user_id, action, entity_type, entity_id, before_json, after_json, created_at)
    VALUES (${sqlValue(auditId)}, ${sqlValue(companyId)}, ${sqlValue(actorUserId)}, 'company.created', 'company', ${sqlValue(companyId)}, '{}', ${sqlValue(JSON.stringify({ name, slug, status: "active" }))}, ${sqlValue(timestamp)});
    COMMIT;
  `);
  return requireCompanyAccess(companyId, ["owner"], actorUserId);
}

export function updateCompanyForActor(
  companyId: string,
  input: { name?: unknown; status?: unknown },
  actorUserId = currentActorUserId()
): CompanyAccess {
  const current = requireCompanyAccess(companyId, ["owner", "admin"], actorUserId);
  const name = typeof input.name === "string" ? input.name.trim() : current.name;
  if (!name) throw new Error("company_name_required");
  if (name.length > 120) throw new Error("company_name_too_long");
  const status = input.status === undefined ? current.status : String(input.status);
  if (status !== "active" && status !== "paused") throw new Error("company_status_invalid");
  const timestamp = nowIso();
  const after = { ...current, name, status, updated_at: timestamp };
  execSql(`
    BEGIN;
    UPDATE companies SET name=${sqlValue(name)}, status=${sqlValue(status)}, updated_at=${sqlValue(timestamp)} WHERE id=${sqlValue(companyId)};
    INSERT INTO company_audit_events (id, company_id, actor_user_id, action, entity_type, entity_id, before_json, after_json, created_at)
    VALUES (${sqlValue(makeId("audit"))}, ${sqlValue(companyId)}, ${sqlValue(actorUserId)}, 'company.updated', 'company', ${sqlValue(companyId)}, ${sqlValue(JSON.stringify(current))}, ${sqlValue(JSON.stringify(after))}, ${sqlValue(timestamp)});
    COMMIT;
  `);
  return requireCompanyAccess(companyId, ["owner", "admin"], actorUserId);
}

export function recordCompanyAudit(
  companyId: string,
  actorUserId: string,
  action: string,
  entityType: string,
  entityId: string,
  before: unknown,
  after: unknown
): void {
  insert("company_audit_events", {
    id: makeId("audit"),
    company_id: companyId,
    actor_user_id: actorUserId,
    action,
    entity_type: entityType,
    entity_id: entityId,
    before_json: JSON.stringify(before ?? {}),
    after_json: JSON.stringify(after ?? {}),
    created_at: nowIso()
  });
}

function backfillLegacyCompanies(actorUserId: string, timestamp: string): void {
  const legacyIds = querySql<{ id: string }>(`
    SELECT DISTINCT CASE WHEN trim(company_id)!='' THEN company_id ELSE project_id END AS id
    FROM mvp_automations
    WHERE trim(CASE WHEN trim(company_id)!='' THEN company_id ELSE project_id END)!=''
  `);
  for (const row of legacyIds) {
    const id = row.id.trim();
    if (!id) continue;
    if (!querySql(`SELECT id FROM companies WHERE id=${sqlValue(id)} LIMIT 1`)[0]) {
      insert("companies", { id, slug: normalizeCompanySlug(id), name: legacyCompanyName(id), status: "active", created_at: timestamp, updated_at: timestamp });
    }
  }
  const explicitLegacyOwnerUserId = process.env.AUTOMATION_OS_LEGACY_OWNER_USER_ID?.trim() || "user_local_owner";
  if (actorUserId === explicitLegacyOwnerUserId) {
    for (const row of legacyIds) {
      const membership = querySql<{ id: string }>(`
        SELECT id FROM company_memberships
        WHERE company_id=${sqlValue(row.id)} AND user_id=${sqlValue(actorUserId)}
        LIMIT 1
      `)[0];
      if (!membership) {
        insert("company_memberships", {
          id: makeId("membership"), company_id: row.id, user_id: actorUserId, role: "owner", status: "active", created_at: timestamp, updated_at: timestamp
        });
      }
    }
  }
  if (legacyIds.length > 0) {
    // project_id remains a compatibility alias until the UI migration is complete.
    const ids = legacyIds.map((row) => sqlValue(row.id)).join(", ");
    if (ids) {
      execSql(`UPDATE mvp_automations SET company_id=project_id WHERE trim(company_id)='' AND project_id IN (${ids});`);
    }
  }
}

function normalizeCompanySlug(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function legacyCompanyName(id: string): string {
  return id
    .replace(/^project[-_]?/i, "Project ")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || id;
}

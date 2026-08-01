import { createHash } from "node:crypto";
import { makeId, nowIso, querySql, runSqlTransaction, sqlValue, type SqlTransactionStep } from "../db/client.js";

export class IdempotencyError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "IdempotencyError";
  }
}

type StoredIdempotencyRow = {
  company_id: string;
  scope: string;
  idempotency_key: string;
  request_hash: string;
  response_json: string;
  status: string;
};

export type IdempotentMutationResult<T> = { replayed: boolean; response: T; requestHash: string };

export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const normalize = (input: unknown): unknown => {
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new IdempotencyError("idempotency_request_not_json");
      return input;
    }
    if (Array.isArray(input)) return input.map((item) => normalize(item));
    if (typeof input === "object") {
      if (seen.has(input)) throw new IdempotencyError("idempotency_request_not_json");
      seen.add(input);
      const object = input as Record<string, unknown>;
      const normalized = Object.fromEntries(
        Object.keys(object)
          .filter((key) => object[key] !== undefined)
          .sort()
          .map((key) => [key, normalize(object[key])])
      );
      seen.delete(input);
      return normalized;
    }
    throw new IdempotencyError("idempotency_request_not_json");
  };
  return JSON.stringify(normalize(value));
}

export function hashIdempotencyRequest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function readIdempotencyReplay<T extends Record<string, unknown>>(input: {
  companyId: string;
  scope: string;
  key: string;
  request: unknown;
}): T | null {
  const companyId = boundedIdentity(input.companyId, "company_id_required");
  const scope = boundedIdentity(input.scope, "idempotency_scope_required");
  const key = boundedIdentity(input.key, "idempotency_key_required", 200);
  return resolveExisting<T>(readStored(companyId, scope, key), hashIdempotencyRequest(input.request));
}

export function runIdempotentSqlMutation<T extends Record<string, unknown>>(input: {
  companyId: string;
  scope: string;
  key: string;
  request: unknown;
  resourceSteps: readonly SqlTransactionStep[];
  response: T;
}): IdempotentMutationResult<T> {
  const companyId = boundedIdentity(input.companyId, "company_id_required");
  const scope = boundedIdentity(input.scope, "idempotency_scope_required");
  const key = boundedIdentity(input.key, "idempotency_key_required", 200);
  const requestHash = hashIdempotencyRequest(input.request);
  const existing = readStored(companyId, scope, key);
  const replay = resolveExisting<T>(existing, requestHash);
  if (replay) return { replayed: true, response: replay, requestHash };

  const id = makeId("idempotency");
  const now = nowIso();
  const responseJson = canonicalJson(input.response);
  const steps: SqlTransactionStep[] = [
    {
      sql: `INSERT INTO mvp_idempotency_keys
            (id, company_id, scope, idempotency_key, request_hash, response_json, status, expires_at, created_at, updated_at)
            VALUES (${sqlValue(id)}, ${sqlValue(companyId)}, ${sqlValue(scope)}, ${sqlValue(key)}, ${sqlValue(requestHash)}, '{}', 'pending', NULL, ${sqlValue(now)}, ${sqlValue(now)})`,
      expectChanges: 1
    },
    ...input.resourceSteps,
    {
      sql: `UPDATE mvp_idempotency_keys
            SET response_json=${sqlValue(responseJson)}, status='completed', updated_at=${sqlValue(now)}
            WHERE id=${sqlValue(id)} AND company_id=${sqlValue(companyId)} AND scope=${sqlValue(scope)}
              AND idempotency_key=${sqlValue(key)} AND request_hash=${sqlValue(requestHash)} AND status='pending'`,
      expectChanges: 1
    }
  ];
  try {
    runSqlTransaction(steps);
    return { replayed: false, response: input.response, requestHash };
  } catch (error) {
    const raced = readStored(companyId, scope, key);
    const racedReplay = resolveExisting<T>(raced, requestHash);
    if (racedReplay) return { replayed: true, response: racedReplay, requestHash };
    throw error;
  }
}

function readStored(companyId: string, scope: string, key: string): StoredIdempotencyRow | undefined {
  return querySql<StoredIdempotencyRow>(`
    SELECT company_id, scope, idempotency_key, request_hash, response_json, status
    FROM mvp_idempotency_keys
    WHERE company_id=${sqlValue(companyId)} AND scope=${sqlValue(scope)} AND idempotency_key=${sqlValue(key)}
    LIMIT 1
  `)[0];
}

function resolveExisting<T>(row: StoredIdempotencyRow | undefined, requestHash: string): T | null {
  if (!row) return null;
  if (row.request_hash !== requestHash) throw new IdempotencyError("idempotency_key_payload_conflict");
  if (row.status === "pending") throw new IdempotencyError("idempotency_request_pending");
  if (row.status !== "completed") throw new IdempotencyError("idempotency_request_incomplete");
  try {
    const parsed = JSON.parse(row.response_json) as T;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    return parsed;
  } catch {
    throw new IdempotencyError("idempotency_response_invalid");
  }
}

function boundedIdentity(value: string, code: string, max = 120): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > max) throw new IdempotencyError(code);
  return normalized;
}

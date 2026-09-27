import { createHash } from "node:crypto";
import { execSqlAsync, makeId, markAsyncSchemaReady, nowIso, querySqlAsync, runSqlTransactionAsync, sqlValue } from "../db/client.js";
import { portableBusinessTargetDigest } from "./portableExternalApprovalBinding.js";

export const NISENPRINTS_TARGET_REGISTRY_SCHEMA = "aos.nisenprints.target_registry.v1" as const;
export const NISENPRINTS_TARGET_REGISTRY_REQUEST_SCHEMA = "aos.nisenprints.target_registry_admission_request.v1" as const;
export const NISENPRINTS_TARGET_REGISTRY_READBACK_SCHEMA = "aos.nisenprints.target_registry_readback.v1" as const;
export const NISENPRINTS_TARGET_WORKFLOW_ID = "nisenprints-daily-product-canva-printify-etsy-pinterest" as const;
export const NISENPRINTS_TARGET_COMPANY_ID = "company_2560580981cedfd106b66245" as const;
export const NISENPRINTS_TARGET_AUTOMATION_ID = "automation_79f86fe8189154f9ea62f0ef" as const;
export const NISENPRINTS_TARGET_ACCOUNT_REF = "okinawa2000823@gmail.com" as const;
export const NISENPRINTS_TARGET_STORE_NAME = "Nisen JP" as const;

const HASH = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][-_A-Za-z0-9.:]{0,239}$/u;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,399}$/u;
const MAX_READBACK_AGE_MS = 30 * 60 * 1000;

export class NisenPrintsTargetRegistryError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "NisenPrintsTargetRegistryError";
  }
}

export type NisenPrintsTargetRegistryInput = {
  workflowId: typeof NISENPRINTS_TARGET_WORKFLOW_ID;
  registeredAutomationId: typeof NISENPRINTS_TARGET_AUTOMATION_ID;
  candidateKey: string;
  accountRef: typeof NISENPRINTS_TARGET_ACCOUNT_REF;
  storeName: typeof NISENPRINTS_TARGET_STORE_NAME;
  targetKey: string;
  providerTargetRef: string;
  providerReadbackRef: string;
  providerReadbackCanonicalSha256: string;
  providerReadback: Record<string, unknown>;
  inputBundleRef: string;
  inputBundleSha256: string;
  inputBundle: Record<string, string | number>;
  sourceSnapshotId: string;
  sourceSnapshotExpiresAt: string;
  ownerRef: string;
  authorityRef: string;
};

export type NisenPrintsTargetRegistryRecord = {
  id: string;
  company_id: typeof NISENPRINTS_TARGET_COMPANY_ID;
  workflow_id: typeof NISENPRINTS_TARGET_WORKFLOW_ID;
  registered_automation_id: typeof NISENPRINTS_TARGET_AUTOMATION_ID;
  candidate_key: string;
  account_ref: typeof NISENPRINTS_TARGET_ACCOUNT_REF;
  store_name: typeof NISENPRINTS_TARGET_STORE_NAME;
  target_key: string;
  provider_target_ref: string;
  provider_readback_ref: string;
  provider_readback_canonical_sha256: string;
  provider_readback_captured_at: string;
  input_bundle_ref: string;
  input_bundle_sha256: string;
  source_snapshot_id: string;
  source_snapshot_expires_at: string;
  target_digest: string;
  owner_ref: string;
  authority_ref: string;
  status: "attested" | "superseded" | "revoked";
  idempotency_key_fingerprint: string;
  created_at: string;
  updated_at: string;
};

type RegistryRow = Omit<NisenPrintsTargetRegistryRecord, "idempotency_key_fingerprint"> & { idempotency_key: string };

export async function ensureNisenPrintsTargetRegistrySchemaAsync(): Promise<void> {
  await execSqlAsync(`
    CREATE TABLE IF NOT EXISTS nisenprints_target_registry (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      workflow_id TEXT NOT NULL CHECK (workflow_id = '${NISENPRINTS_TARGET_WORKFLOW_ID}'),
      registered_automation_id TEXT NOT NULL,
      candidate_key TEXT NOT NULL,
      account_ref TEXT NOT NULL,
      store_name TEXT NOT NULL,
      target_key TEXT NOT NULL,
      provider_target_ref TEXT NOT NULL,
      provider_readback_ref TEXT NOT NULL,
      provider_readback_canonical_sha256 TEXT NOT NULL CHECK (length(provider_readback_canonical_sha256) = 64),
      provider_readback_captured_at TEXT NOT NULL,
      input_bundle_ref TEXT NOT NULL,
      input_bundle_sha256 TEXT NOT NULL CHECK (length(input_bundle_sha256) = 64),
      source_snapshot_id TEXT NOT NULL,
      source_snapshot_expires_at TEXT NOT NULL,
      target_digest TEXT NOT NULL CHECK (length(target_digest) = 64),
      owner_ref TEXT NOT NULL,
      authority_ref TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'attested' CHECK (status IN ('attested', 'superseded', 'revoked')),
      idempotency_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(company_id, workflow_id, candidate_key),
      UNIQUE(company_id, workflow_id, target_key),
      UNIQUE(company_id, workflow_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS nisenprints_target_registry_company_idx
      ON nisenprints_target_registry(company_id, workflow_id, status, updated_at DESC);
  `);
  markAsyncSchemaReady();
}

export function parseNisenPrintsTargetRegistryInput(value: unknown, now = nowIso()): NisenPrintsTargetRegistryInput {
  const body = record(value, "nisenprints_target_registry_request_required");
  const allowed = new Set([
    "schema", "workflow_id", "registered_automation_id", "candidate_key", "account_ref", "store_name", "target_key",
    "provider_target_ref", "provider_readback_ref", "provider_readback_canonical_sha256", "provider_readback",
    "input_bundle_ref", "input_bundle_sha256", "input_bundle", "source_snapshot_id", "source_snapshot_expires_at",
    "owner_ref", "authority_ref"
  ]);
  for (const key of Object.keys(body)) if (!allowed.has(key)) throw new NisenPrintsTargetRegistryError("nisenprints_target_registry_unknown_field");
  if (body.schema !== NISENPRINTS_TARGET_REGISTRY_REQUEST_SCHEMA) throw new NisenPrintsTargetRegistryError("nisenprints_target_registry_schema_invalid");
  if (body.workflow_id !== NISENPRINTS_TARGET_WORKFLOW_ID) throw new NisenPrintsTargetRegistryError("nisenprints_target_registry_workflow_invalid");
  if (body.registered_automation_id !== NISENPRINTS_TARGET_AUTOMATION_ID) throw new NisenPrintsTargetRegistryError("nisenprints_target_registry_automation_invalid");
  if (body.account_ref !== NISENPRINTS_TARGET_ACCOUNT_REF) throw new NisenPrintsTargetRegistryError("nisenprints_target_registry_account_invalid");
  if (body.store_name !== NISENPRINTS_TARGET_STORE_NAME) throw new NisenPrintsTargetRegistryError("nisenprints_target_registry_store_invalid");

  const candidateKey = requiredIdentifier(body.candidate_key, "candidate_key");
  const targetKey = requiredIdentifier(body.target_key, "target_key");
  const providerTargetRef = requiredSafeRef(body.provider_target_ref, "provider_target_ref");
  const providerReadbackRef = requiredSafeRef(body.provider_readback_ref, "provider_readback_ref");
  const providerReadbackCanonicalSha256 = requiredHash(body.provider_readback_canonical_sha256, "provider_readback_canonical_sha256");
  const inputBundleRef = requiredSafeRef(body.input_bundle_ref, "input_bundle_ref");
  const inputBundleSha256 = requiredHash(body.input_bundle_sha256, "input_bundle_sha256");
  const sourceSnapshotId = requiredSafeRef(body.source_snapshot_id, "source_snapshot_id");
  const sourceSnapshotExpiresAt = futureIso(body.source_snapshot_expires_at, now, "source_snapshot_expires_at");
  const ownerRef = requiredSafeRef(body.owner_ref, "owner_ref");
  const authorityRef = requiredSafeRef(body.authority_ref, "authority_ref");
  if (secretLike(ownerRef) || secretLike(authorityRef) || secretLike(providerTargetRef)) {
    throw new NisenPrintsTargetRegistryError("nisenprints_target_registry_secret_like_reference_forbidden");
  }

  const providerReadback = record(body.provider_readback, "nisenprints_target_registry_provider_readback_required");
  validateProviderReadback(providerReadback, { targetKey, providerTargetRef, accountRef: NISENPRINTS_TARGET_ACCOUNT_REF, storeName: NISENPRINTS_TARGET_STORE_NAME, now });
  if (sha256(JSON.stringify(providerReadback)) !== providerReadbackCanonicalSha256) {
    throw new NisenPrintsTargetRegistryError("nisenprints_target_registry_provider_readback_hash_mismatch");
  }

  const inputBundle = parseInputBundle(body.input_bundle);
  if (inputBundle.account_ref !== NISENPRINTS_TARGET_ACCOUNT_REF
    || inputBundle.target_key !== targetKey
    || inputBundle.candidate_key !== candidateKey
    || inputBundle.source_snapshot_id !== sourceSnapshotId
    || inputBundle.input_bundle_ref !== inputBundleRef
    || inputBundle.source_snapshot_expires_at !== sourceSnapshotExpiresAt) {
    throw new NisenPrintsTargetRegistryError("nisenprints_target_registry_input_binding_mismatch");
  }
  if (!HASH.test(String(inputBundle.payload_hash ?? ""))) throw new NisenPrintsTargetRegistryError("nisenprints_target_registry_payload_hash_missing");
  return {
    workflowId: NISENPRINTS_TARGET_WORKFLOW_ID,
    registeredAutomationId: NISENPRINTS_TARGET_AUTOMATION_ID,
    candidateKey,
    accountRef: NISENPRINTS_TARGET_ACCOUNT_REF,
    storeName: NISENPRINTS_TARGET_STORE_NAME,
    targetKey,
    providerTargetRef,
    providerReadbackRef,
    providerReadbackCanonicalSha256,
    providerReadback,
    inputBundleRef,
    inputBundleSha256,
    inputBundle,
    sourceSnapshotId,
    sourceSnapshotExpiresAt,
    ownerRef,
    authorityRef
  };
}

export async function registerNisenPrintsTarget(input: {
  companyId: string;
  idempotencyKey: string;
  admission: NisenPrintsTargetRegistryInput;
}): Promise<{ replayed: boolean; registry: NisenPrintsTargetRegistryRecord }> {
  if (input.companyId !== NISENPRINTS_TARGET_COMPANY_ID) throw new NisenPrintsTargetRegistryError("nisenprints_target_registry_company_scope_mismatch");
  const idempotencyKey = requiredSafeRef(input.idempotencyKey, "idempotency_key");
  await ensureNisenPrintsTargetRegistrySchemaAsync();
  const existingByKey = (await querySqlAsync<RegistryRow>(`
    SELECT * FROM nisenprints_target_registry
    WHERE company_id=${sqlValue(input.companyId)} AND workflow_id=${sqlValue(NISENPRINTS_TARGET_WORKFLOW_ID)}
      AND (idempotency_key=${sqlValue(idempotencyKey)} OR candidate_key=${sqlValue(input.admission.candidateKey)} OR target_key=${sqlValue(input.admission.targetKey)})
    ORDER BY created_at DESC LIMIT 1
  `))[0];
  const targetDigest = portableBusinessTargetDigest(input.admission.inputBundle);
  if (existingByKey) {
    const stableIdentityMatches = existingByKey.company_id === input.companyId
      && existingByKey.workflow_id === input.admission.workflowId
      && existingByKey.registered_automation_id === input.admission.registeredAutomationId
      && existingByKey.candidate_key === input.admission.candidateKey
      && existingByKey.account_ref === input.admission.accountRef
      && existingByKey.store_name === input.admission.storeName
      && existingByKey.target_key === input.admission.targetKey
      && existingByKey.provider_target_ref === input.admission.providerTargetRef;
    if (!stableIdentityMatches) {
      throw new NisenPrintsTargetRegistryError("nisenprints_target_registry_identity_conflict");
    }
    if (existingByKey.status !== "attested") {
      throw new NisenPrintsTargetRegistryError("nisenprints_target_registry_existing_target_not_refreshable");
    }
    if (existingByKey.target_digest === targetDigest
      && existingByKey.input_bundle_sha256 === input.admission.inputBundleSha256
      && existingByKey.idempotency_key === idempotencyKey) {
      return { replayed: true, registry: registryApiView(existingByKey) };
    }
    // A fresh no-effect Companion readback may renew the same exact
    // candidate/target binding after its source snapshot expires.  This is
    // not a new target admission: the stable candidate, account, store, and
    // provider ref must remain identical; the refreshed immutable bundle is
    // allowed to carry the new source snapshot identity.
    const updatedAt = nowIso();
    await runSqlTransactionAsync([{
      sql: `UPDATE nisenprints_target_registry SET
        provider_readback_ref=${sqlValue(input.admission.providerReadbackRef)},
        provider_readback_canonical_sha256=${sqlValue(input.admission.providerReadbackCanonicalSha256)},
        provider_readback_captured_at=${sqlValue(String(record(input.admission.providerReadback, "nisenprints_target_registry_provider_readback_required").captured_at))},
        input_bundle_sha256=${sqlValue(input.admission.inputBundleSha256)},
        source_snapshot_id=${sqlValue(input.admission.sourceSnapshotId)},
        source_snapshot_expires_at=${sqlValue(input.admission.sourceSnapshotExpiresAt)},
        target_digest=${sqlValue(targetDigest)},
        owner_ref=${sqlValue(input.admission.ownerRef)},
        authority_ref=${sqlValue(input.admission.authorityRef)},
        idempotency_key=${sqlValue(idempotencyKey)},
        updated_at=${sqlValue(updatedAt)}
        WHERE id=${sqlValue(existingByKey.id)} AND company_id=${sqlValue(input.companyId)} AND status='attested'`,
      expectChanges: 1
    }]);
    const refreshed = (await querySqlAsync<RegistryRow>(`SELECT * FROM nisenprints_target_registry WHERE id=${sqlValue(existingByKey.id)} LIMIT 1`))[0];
    if (!refreshed) throw new NisenPrintsTargetRegistryError("nisenprints_target_registry_refresh_readback_missing");
    return { replayed: false, registry: registryApiView(refreshed) };
  }
  const id = makeId("nisenprints_target");
  const createdAt = nowIso();
  await runSqlTransactionAsync([{
    sql: `INSERT INTO nisenprints_target_registry
      (id, company_id, workflow_id, registered_automation_id, candidate_key, account_ref, store_name, target_key,
       provider_target_ref, provider_readback_ref, provider_readback_canonical_sha256, provider_readback_captured_at,
       input_bundle_ref, input_bundle_sha256, source_snapshot_id, source_snapshot_expires_at, target_digest,
       owner_ref, authority_ref, status, idempotency_key, created_at, updated_at)
      VALUES (${sqlValue(id)}, ${sqlValue(input.companyId)}, ${sqlValue(input.admission.workflowId)}, ${sqlValue(input.admission.registeredAutomationId)},
        ${sqlValue(input.admission.candidateKey)}, ${sqlValue(input.admission.accountRef)}, ${sqlValue(input.admission.storeName)}, ${sqlValue(input.admission.targetKey)},
        ${sqlValue(input.admission.providerTargetRef)}, ${sqlValue(input.admission.providerReadbackRef)}, ${sqlValue(input.admission.providerReadbackCanonicalSha256)},
        ${sqlValue(String(record(input.admission.providerReadback, "nisenprints_target_registry_provider_readback_required").captured_at))}, ${sqlValue(input.admission.inputBundleRef)}, ${sqlValue(input.admission.inputBundleSha256)},
        ${sqlValue(input.admission.sourceSnapshotId)}, ${sqlValue(input.admission.sourceSnapshotExpiresAt)}, ${sqlValue(targetDigest)},
        ${sqlValue(input.admission.ownerRef)}, ${sqlValue(input.admission.authorityRef)}, 'attested', ${sqlValue(idempotencyKey)}, ${sqlValue(createdAt)}, ${sqlValue(createdAt)})`,
    expectChanges: 1
  }]);
  const saved = (await querySqlAsync<RegistryRow>(`SELECT * FROM nisenprints_target_registry WHERE id=${sqlValue(id)} LIMIT 1`))[0];
  if (!saved) throw new NisenPrintsTargetRegistryError("nisenprints_target_registry_readback_missing");
  return { replayed: false, registry: registryApiView(saved) };
}

export async function listNisenPrintsTargets(companyId: string): Promise<NisenPrintsTargetRegistryRecord[]> {
  if (companyId !== NISENPRINTS_TARGET_COMPANY_ID) throw new NisenPrintsTargetRegistryError("nisenprints_target_registry_company_scope_mismatch");
  await ensureNisenPrintsTargetRegistrySchemaAsync();
  const rows = await querySqlAsync<RegistryRow>(`SELECT * FROM nisenprints_target_registry WHERE company_id=${sqlValue(companyId)} AND workflow_id=${sqlValue(NISENPRINTS_TARGET_WORKFLOW_ID)} ORDER BY updated_at DESC`);
  return rows.map(registryApiView);
}

export async function assertNisenPrintsTargetRegistryForRun(input: {
  companyId: string;
  inputBundle: Record<string, unknown>;
}): Promise<NisenPrintsTargetRegistryRecord> {
  if (input.companyId !== NISENPRINTS_TARGET_COMPANY_ID) throw new NisenPrintsTargetRegistryError("nisenprints_target_registry_company_scope_mismatch");
  await ensureNisenPrintsTargetRegistrySchemaAsync();
  const candidateKey = stringValue(input.inputBundle.candidate_key);
  const targetKey = stringValue(input.inputBundle.target_key);
  const accountRef = stringValue(input.inputBundle.account_ref);
  if (!candidateKey || !targetKey || accountRef !== NISENPRINTS_TARGET_ACCOUNT_REF) {
    throw new NisenPrintsTargetRegistryError("nisenprints_registered_target_attestation_missing");
  }
  const targetDigest = portableBusinessTargetDigest(input.inputBundle);
  const row = (await querySqlAsync<RegistryRow>(`
    SELECT * FROM nisenprints_target_registry
    WHERE company_id=${sqlValue(input.companyId)} AND workflow_id=${sqlValue(NISENPRINTS_TARGET_WORKFLOW_ID)}
      AND candidate_key=${sqlValue(candidateKey)} AND target_key=${sqlValue(targetKey)} AND status='attested'
    ORDER BY updated_at DESC LIMIT 1
  `))[0];
  if (!row) throw new NisenPrintsTargetRegistryError("nisenprints_registered_target_attestation_missing");
  if (row.account_ref !== accountRef || row.target_digest !== targetDigest || row.source_snapshot_id !== stringValue(input.inputBundle.source_snapshot_id)) {
    throw new NisenPrintsTargetRegistryError("nisenprints_registered_target_attestation_mismatch");
  }
  if (Date.parse(row.source_snapshot_expires_at) <= Date.now()) throw new NisenPrintsTargetRegistryError("nisenprints_registered_target_source_snapshot_expired");
  return registryApiView(row);
}

function validateProviderReadback(value: Record<string, unknown>, expected: { targetKey: string; providerTargetRef: string; accountRef: string; storeName: string; now: string }): void {
  if (value.schema !== "aos.nisenprints.target_readback.v1") throw new NisenPrintsTargetRegistryError("nisenprints_target_registry_provider_readback_schema_invalid");
  const identity = record(value.observed_identity, "nisenprints_target_registry_provider_identity_missing");
  const resolution = record(value.target_resolution, "nisenprints_target_registry_target_resolution_missing");
  const effect = record(value.effect, "nisenprints_target_registry_effect_readback_missing");
  const cleanup = record(value.cleanup, "nisenprints_target_registry_cleanup_readback_missing");
  if (identity.account_ref !== expected.accountRef || identity.store_name !== expected.storeName) throw new NisenPrintsTargetRegistryError("nisenprints_target_registry_provider_identity_mismatch");
  if (resolution.status !== "resolved" || resolution.target_key !== expected.targetKey || resolution.provider_target_ref !== expected.providerTargetRef || resolution.registered_aos_target_attested !== true) {
    throw new NisenPrintsTargetRegistryError("nisenprints_target_registry_target_not_attested");
  }
  if (effect.browser_mutation_executed !== false || effect.external_action_executed !== false || effect.provider_business_action !== false) {
    throw new NisenPrintsTargetRegistryError("nisenprints_target_registry_effect_boundary_invalid");
  }
  if (cleanup.session_closed !== true || cleanup.transaction_lease_released !== true) throw new NisenPrintsTargetRegistryError("nisenprints_target_registry_cleanup_missing");
  const capturedAt = value.captured_at;
  const capturedMs = typeof capturedAt === "string" ? Date.parse(capturedAt) : Number.NaN;
  const nowMs = Date.parse(expected.now);
  if (!Number.isFinite(capturedMs) || !Number.isFinite(nowMs) || capturedMs > nowMs || nowMs - capturedMs > MAX_READBACK_AGE_MS) {
    throw new NisenPrintsTargetRegistryError("nisenprints_target_registry_provider_readback_stale");
  }
}

function parseInputBundle(value: unknown): Record<string, string | number> {
  const body = record(value, "nisenprints_target_registry_input_bundle_required");
  const output: Record<string, string | number> = {};
  for (const [key, raw] of Object.entries(body)) {
    if (!/^(?:[A-Za-z][A-Za-z0-9_]{0,63})$/u.test(key) || /(token|cookie|password|secret|authorization|credential|storage[_-]?state|profile[_-]?path)/iu.test(key)) {
      throw new NisenPrintsTargetRegistryError("nisenprints_target_registry_input_bundle_key_forbidden");
    }
    if (typeof raw === "string" && raw.trim() && raw.length <= 1000) output[key] = raw.trim();
    else if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) output[key] = raw;
    else throw new NisenPrintsTargetRegistryError("nisenprints_target_registry_input_bundle_value_invalid");
  }
  return output;
}

function registryApiView(row: RegistryRow): NisenPrintsTargetRegistryRecord {
  const { idempotency_key: idempotencyKey, ...rest } = row;
  return { ...rest, idempotency_key_fingerprint: fingerprint(idempotencyKey) };
}

function record(value: unknown, errorCode: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NisenPrintsTargetRegistryError(errorCode);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function requiredIdentifier(value: unknown, field: string): string {
  const result = stringValue(value);
  if (!IDENTIFIER.test(result)) throw new NisenPrintsTargetRegistryError(`nisenprints_target_registry_${field}_invalid`);
  return result;
}

function requiredSafeRef(value: unknown, field: string): string {
  const result = stringValue(value);
  if (!SAFE_REF.test(result)) throw new NisenPrintsTargetRegistryError(`nisenprints_target_registry_${field}_invalid`);
  return result;
}

function requiredHash(value: unknown, field: string): string {
  const result = stringValue(value);
  if (!HASH.test(result)) throw new NisenPrintsTargetRegistryError(`nisenprints_target_registry_${field}_invalid`);
  return result;
}

function futureIso(value: unknown, now: string, field: string): string {
  const result = stringValue(value);
  const valueMs = Date.parse(result);
  const nowMs = Date.parse(now);
  if (!result || !Number.isFinite(valueMs) || !Number.isFinite(nowMs) || valueMs <= nowMs) {
    throw new NisenPrintsTargetRegistryError(`nisenprints_target_registry_${field}_invalid`);
  }
  return result;
}

function secretLike(value: string): boolean {
  return /(token|cookie|password|secret|authorization|credential|private.?key|otp|security.?code|session)/iu.test(value);
}

function fingerprint(value: string): string {
  return sha256(value).slice(0, 16);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

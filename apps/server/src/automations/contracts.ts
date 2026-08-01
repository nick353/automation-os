export class AutomationContractError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "AutomationContractError";
  }
}

type JsonObject = Record<string, unknown>;

const automationFields = new Set([
  "automation_type",
  "name",
  "description",
  "desc",
  "goal",
  "lane",
  "risk_level",
  "approval_policy",
  "worker_command_kind",
  "create_approval",
  "builder_spec"
]);

const safeIdentifier = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const memoryKinds = new Set(["business_context", "brand", "product", "policy", "custom"]);
const connectionStatuses = new Set(["configured", "verified", "reconnect_required", "revoked"]);
const connectionOauthStates = new Set(["not_configured", "pending_authorization", "connected", "reauthorization_required", "expired", "error", "revoked", "not_applicable"]);
const connectionVerificationStatuses = new Set(["unverified", "verified", "failed", "expired"]);
const scheduleKinds = new Set(["manual", "daily", "weekly", "cron"]);

export type AutomationDefinitionInput = {
  automationType: string;
  name: string;
  description: string;
  goal: string;
  lane: string;
  riskLevel: string;
  approvalPolicy: string;
  workerCommandKind: string;
  createApproval: boolean;
  builderSpec: JsonObject;
};

export type AutomationPatchInput = Partial<AutomationDefinitionInput> & { expectedRevision: number };

export function parseAutomationCreate(value: unknown): AutomationDefinitionInput {
  const body = objectValue(value, "automation_body_required");
  rejectUnknownFields(body, automationFields, "automation_unknown_field");
  if (body.description !== undefined && body.desc !== undefined && body.description !== body.desc) {
    throw new AutomationContractError("automation_description_conflict");
  }
  return {
    automationType: identifier(body.automation_type, "automation_type", true),
    name: boundedString(body.name, "automation_name", 1, 120),
    description: boundedString(body.description ?? body.desc ?? "", "automation_description", 0, 2000),
    goal: boundedString(body.goal ?? "", "automation_goal", 0, 4000),
    lane: boundedString(body.lane ?? "local", "automation_lane", 1, 120),
    riskLevel: identifier(body.risk_level ?? "high", "automation_risk_level", true),
    approvalPolicy: identifier(body.approval_policy ?? "required_before_external_action", "automation_approval_policy", true),
    workerCommandKind: identifier(body.worker_command_kind ?? "safe_local_demo", "automation_worker_command_kind", true),
    createApproval: booleanValue(body.create_approval ?? true, "automation_create_approval"),
    builderSpec: objectValue(body.builder_spec ?? {}, "automation_builder_spec_invalid")
  };
}

export function parseAutomationPatch(value: unknown, expectedRevisionValue?: unknown): AutomationPatchInput {
  const body = objectValue(value, "automation_body_required");
  const allowed = new Set([...automationFields, "expected_revision"]);
  rejectUnknownFields(body, allowed, "automation_unknown_field");
  const expectedRevision = positiveInteger(expectedRevisionValue ?? body.expected_revision, "automation_expected_revision_required");
  const withoutRevision = { ...body };
  delete withoutRevision.expected_revision;
  if (Object.keys(withoutRevision).length === 0) throw new AutomationContractError("automation_patch_empty");
  if (body.description !== undefined && body.desc !== undefined && body.description !== body.desc) {
    throw new AutomationContractError("automation_description_conflict");
  }
  const patch: AutomationPatchInput = { expectedRevision };
  if (body.automation_type !== undefined) patch.automationType = identifier(body.automation_type, "automation_type", true);
  if (body.name !== undefined) patch.name = boundedString(body.name, "automation_name", 1, 120);
  if (body.description !== undefined || body.desc !== undefined) patch.description = boundedString(body.description ?? body.desc, "automation_description", 0, 2000);
  if (body.goal !== undefined) patch.goal = boundedString(body.goal, "automation_goal", 0, 4000);
  if (body.lane !== undefined) patch.lane = boundedString(body.lane, "automation_lane", 1, 120);
  if (body.risk_level !== undefined) patch.riskLevel = identifier(body.risk_level, "automation_risk_level", true);
  if (body.approval_policy !== undefined) patch.approvalPolicy = identifier(body.approval_policy, "automation_approval_policy", true);
  if (body.worker_command_kind !== undefined) patch.workerCommandKind = identifier(body.worker_command_kind, "automation_worker_command_kind", true);
  if (body.create_approval !== undefined) patch.createApproval = booleanValue(body.create_approval, "automation_create_approval");
  if (body.builder_spec !== undefined) patch.builderSpec = objectValue(body.builder_spec, "automation_builder_spec_invalid");
  return patch;
}

export type AutomationScheduleInput = {
  kind: "manual" | "daily" | "weekly" | "cron";
  expression: string | null;
  timezone: string;
  enabled: boolean;
  expectedRevision: number;
};

export function parseAutomationSchedule(value: unknown): AutomationScheduleInput {
  const body = objectValue(value, "automation_schedule_body_required");
  rejectUnknownFields(body, new Set(["kind", "expression", "timezone", "enabled", "expected_revision"]), "automation_schedule_unknown_field");
  const kind = boundedString(body.kind, "automation_schedule_kind", 1, 20);
  if (!scheduleKinds.has(kind)) throw new AutomationContractError("automation_schedule_kind_invalid");
  const expression = body.expression === null || body.expression === undefined
    ? null
    : boundedString(body.expression, "automation_schedule_expression", 1, 240);
  if (kind !== "manual" && !expression) throw new AutomationContractError("automation_schedule_expression_required");
  if (kind === "manual" && expression) throw new AutomationContractError("automation_manual_schedule_expression_forbidden");
  const timezone = boundedString(body.timezone ?? "UTC", "automation_schedule_timezone", 1, 100);
  if (!/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(timezone)) throw new AutomationContractError("automation_schedule_timezone_invalid");
  return {
    kind: kind as AutomationScheduleInput["kind"],
    expression,
    timezone,
    enabled: booleanValue(body.enabled ?? true, "automation_schedule_enabled"),
    expectedRevision: positiveInteger(body.expected_revision, "automation_expected_revision_required")
  };
}

export type CompanyMemoryInput = { key: string; kind: string; title: string; body: string; expectedRevision: number | null };

export function parseCompanyMemory(value: unknown, requireRevision = false): CompanyMemoryInput {
  const body = objectValue(value, "company_memory_body_required");
  rejectUnknownFields(body, new Set(["key", "kind", "title", "body", "expected_revision"]), "company_memory_unknown_field");
  const key = identifier(body.key, "company_memory_key", true);
  const kind = boundedString(body.kind ?? "custom", "company_memory_kind", 1, 40);
  if (!memoryKinds.has(kind)) throw new AutomationContractError("company_memory_kind_invalid");
  return {
    key,
    kind,
    title: boundedString(body.title, "company_memory_title", 1, 120),
    body: boundedString(body.body, "company_memory_body", 0, 20000),
    expectedRevision: requireRevision ? positiveInteger(body.expected_revision, "company_memory_expected_revision_required") : null
  };
}

export type CompanyConnectionAccountRefInput = {
  platform: string;
  accountRef: string;
  status: string;
  scopes: string[];
  expiresAt: string | null;
  oauthState: string;
  verificationStatus: string;
  lastVerifiedAt: string | null;
  expectedRevision: number | null;
};

export function parseCompanyConnectionAccountRef(value: unknown, requireRevision = false): CompanyConnectionAccountRefInput {
  const body = objectValue(value, "company_connection_ref_body_required");
  const forbiddenSecretFields = ["password", "token", "access_token", "refresh_token", "secret", "secret_value", "api_key"];
  if (forbiddenSecretFields.some((field) => Object.prototype.hasOwnProperty.call(body, field))) {
    throw new AutomationContractError("company_connection_secret_material_forbidden");
  }
  rejectUnknownFields(body, new Set(["platform", "account_ref", "status", "scopes", "expires_at", "oauth_state", "verification_status", "last_verified_at", "expected_revision"]), "company_connection_ref_unknown_field");
  const status = boundedString(body.status ?? "configured", "company_connection_ref_status", 1, 40);
  if (!connectionStatuses.has(status)) throw new AutomationContractError("company_connection_ref_status_invalid");
  if (status === "reconnect_required" || status === "revoked") throw new AutomationContractError("company_connection_ref_lifecycle_action_required");
  const oauthState = boundedString(body.oauth_state ?? "not_configured", "company_connection_ref_oauth_state", 1, 40);
  if (!connectionOauthStates.has(oauthState)) throw new AutomationContractError("company_connection_ref_oauth_state_invalid");
  const verificationStatus = boundedString(body.verification_status ?? "unverified", "company_connection_ref_verification_status", 1, 40);
  if (!connectionVerificationStatuses.has(verificationStatus)) throw new AutomationContractError("company_connection_ref_verification_status_invalid");
  const scopes = stringArray(body.scopes ?? [], "company_connection_ref_scopes", 100, 120);
  const expiresAt = body.expires_at === null || body.expires_at === undefined
    ? null
    : isoTimestamp(body.expires_at, "company_connection_ref_expires_at");
  const lastVerifiedAt = body.last_verified_at === null || body.last_verified_at === undefined
    ? null
    : isoTimestamp(body.last_verified_at, "company_connection_ref_last_verified_at");
  if (verificationStatus === "verified" && !lastVerifiedAt) throw new AutomationContractError("company_connection_ref_last_verified_at_required");
  if (status === "verified" && verificationStatus !== "verified") throw new AutomationContractError("company_connection_ref_verification_status_mismatch");
  if (verificationStatus === "verified" && status !== "verified") throw new AutomationContractError("company_connection_ref_status_mismatch");
  if (verificationStatus === "verified" && oauthState !== "connected" && oauthState !== "not_applicable") {
    throw new AutomationContractError("company_connection_ref_oauth_state_mismatch");
  }
  if (lastVerifiedAt && expiresAt && Date.parse(expiresAt) <= Date.parse(lastVerifiedAt)) {
    throw new AutomationContractError("company_connection_ref_expiry_not_after_verification");
  }
  return {
    platform: identifier(body.platform, "company_connection_ref_platform", true),
    accountRef: boundedString(body.account_ref, "company_connection_ref_account", 1, 500),
    status,
    scopes,
    expiresAt,
    oauthState,
    verificationStatus,
    lastVerifiedAt,
    expectedRevision: requireRevision ? positiveInteger(body.expected_revision, "company_connection_ref_expected_revision_required") : null
  };
}

export function requireIdempotencyKey(value: unknown): string {
  const key = boundedString(value, "idempotency_key", 8, 200);
  if (!/^[A-Za-z0-9._:-]+$/.test(key)) throw new AutomationContractError("idempotency_key_invalid");
  return key;
}

function objectValue(value: unknown, code: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AutomationContractError(code);
  return value as JsonObject;
}

function rejectUnknownFields(body: JsonObject, allowed: Set<string>, code: string): void {
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) throw new AutomationContractError(`${code}:${unknown.sort().join(",")}`);
}

function boundedString(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") throw new AutomationContractError(`${field}_invalid`);
  const normalized = value.trim();
  if (normalized.length < min) throw new AutomationContractError(`${field}_required`);
  if (normalized.length > max) throw new AutomationContractError(`${field}_too_long`);
  return normalized;
}

function identifier(value: unknown, field: string, required: boolean): string {
  const normalized = boundedString(value, field, required ? 1 : 0, 80);
  if (normalized && !safeIdentifier.test(normalized)) throw new AutomationContractError(`${field}_invalid`);
  return normalized;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new AutomationContractError(`${field}_invalid`);
  return value;
}

function positiveInteger(value: unknown, code: string): number {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || Number(number) < 1) throw new AutomationContractError(code);
  return Number(number);
}

function stringArray(value: unknown, field: string, maxItems: number, maxItemLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new AutomationContractError(`${field}_invalid`);
  const result = value.map((item) => boundedString(item, field, 1, maxItemLength));
  if (new Set(result).size !== result.length) throw new AutomationContractError(`${field}_duplicate`);
  return result;
}

function isoTimestamp(value: unknown, field: string): string {
  const normalized = boundedString(value, field, 1, 80);
  if (!Number.isFinite(Date.parse(normalized))) throw new AutomationContractError(`${field}_invalid`);
  return new Date(normalized).toISOString();
}

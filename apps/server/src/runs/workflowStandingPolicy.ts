import { createHash } from "node:crypto";

export const WORKFLOW_STANDING_POLICY_SCHEMA = "aos.workflow_standing_policy.v1" as const;
export const WORKFLOW_AUTHORIZATION_READBACK_SCHEMA = "aos.workflow_authorization_readback.v1" as const;

export type WorkflowStandingPolicy = {
  schema: typeof WORKFLOW_STANDING_POLICY_SCHEMA;
  workflow_id: string;
  policy_id: string;
  effect_stages: string[];
  provider_adapters: string[];
  authorization_scope: "workflow_account_target_payload";
  fresh_readback_required: true;
  max_age_ms: number;
  external_action_default: false;
};

export type WorkflowAuthorizationReadback = {
  schema: typeof WORKFLOW_AUTHORIZATION_READBACK_SCHEMA;
  workflow_id: string;
  policy_id: string;
  company_id: string;
  provider: string;
  account_ref: string;
  scope_digest: string;
  verified_at: string;
  expires_at: string;
  status: "verified";
};

export type WorkflowConnectionAuthorizationCandidate = {
  accountRef: string;
  platform: string;
  status: string;
  verificationStatus: string;
  oauthState: string;
  lastVerifiedAt: string | null;
  expiresAt: string | null;
};

const policies: Record<string, WorkflowStandingPolicy> = {
  "daily-ai-research-publish-run": policy("daily-ai-research-publish-run", ["publish", "feed_study_and_engagement"], ["social-platform"]),
  "job-application-manager": policy("job-application-manager", ["candidate_submit"], ["job-board"]),
  "nisenprints-daily-product-canva-printify-etsy-pinterest": policy("nisenprints-daily-product-canva-printify-etsy-pinterest", ["provider_mutations", "etsy_and_pinterest_publish"], ["canva", "printify", "etsy", "pinterest"]),
  "sns-multi-poster-ukiyoe": policy("sns-multi-poster-ukiyoe", ["external_post"], ["social-platform"]),
  "x-authenticated-browser-lane": policy("x-authenticated-browser-lane", ["external_post"], ["social-platform"]),
  "email-review-reply": policy("email-review-reply", ["send_or_create_event"], ["gmail"]),
  "daily-backup-safety-check": policy("daily-backup-safety-check", ["backup_effect"], ["backup"]),
  "obsidian-project-memory-audit": policy("obsidian-project-memory-audit", [], ["obsidian"])
};

function policy(workflowId: string, effectStages: string[], providerAdapters: string[]): WorkflowStandingPolicy {
  return {
    schema: WORKFLOW_STANDING_POLICY_SCHEMA,
    workflow_id: workflowId,
    policy_id: `standing-policy:${workflowId}:v1`,
    effect_stages: effectStages,
    provider_adapters: providerAdapters,
    authorization_scope: "workflow_account_target_payload",
    fresh_readback_required: true,
    max_age_ms: 10 * 60_000,
    external_action_default: false
  };
}

export function getWorkflowStandingPolicy(workflowId: string): WorkflowStandingPolicy | null {
  const value = policies[workflowId];
  return value ? structuredClone(value) : null;
}

export function standingPolicyReadback(workflowId: string): Record<string, unknown> {
  const value = getWorkflowStandingPolicy(workflowId);
  if (!value) return { schema: WORKFLOW_STANDING_POLICY_SCHEMA, workflow_id: workflowId, status: "blocked", exact_blocker: "workflow_standing_policy_unknown", external_action_allowed: false };
  return { ...value, status: "blocked", exact_blocker: "fresh_provider_authorization_readback_required", external_action_allowed: false };
}

export function validateWorkflowAuthorizationReadback(input: unknown, expected: { workflowId: string; companyId: string; policyId: string; nowMs?: number }): WorkflowAuthorizationReadback {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("workflow_authorization_readback_invalid");
  const value = input as Record<string, unknown>;
  if (value.schema !== WORKFLOW_AUTHORIZATION_READBACK_SCHEMA || value.status !== "verified" || value.workflow_id !== expected.workflowId || value.company_id !== expected.companyId || value.policy_id !== expected.policyId) throw new Error("workflow_authorization_readback_binding_invalid");
  for (const key of ["provider", "account_ref", "scope_digest", "verified_at", "expires_at"]) if (typeof value[key] !== "string" || !(value[key] as string).trim()) throw new Error(`workflow_authorization_readback_${key}_missing`);
  const nowMs = expected.nowMs ?? Date.now();
  const verifiedAt = Date.parse(value.verified_at as string);
  const expiresAt = Date.parse(value.expires_at as string);
  const policyValue = getWorkflowStandingPolicy(expected.workflowId);
  if (!policyValue || policyValue.policy_id !== expected.policyId || !Number.isFinite(verifiedAt) || !Number.isFinite(expiresAt) || verifiedAt > nowMs || expiresAt <= nowMs || nowMs - verifiedAt > policyValue.max_age_ms) throw new Error("workflow_authorization_readback_stale");
  return value as unknown as WorkflowAuthorizationReadback;
}

export function authorizationScopeDigest(input: { companyId: string; workflowId: string; provider: string; accountRef: string; targetDigest: string; payloadHash: string }): string {
  return createHash("sha256").update([input.companyId, input.workflowId, input.provider, input.accountRef, input.targetDigest, input.payloadHash].join("\u001f")).digest("hex");
}

export function buildConnectionAuthorizationReadback(input: {
  companyId: string;
  workflowId: string;
  accountRef: string;
  targetDigest: string;
  payloadHash: string;
  connection: WorkflowConnectionAuthorizationCandidate;
  nowMs?: number;
}): WorkflowAuthorizationReadback | null {
  const policyValue = getWorkflowStandingPolicy(input.workflowId);
  const nowMs = input.nowMs ?? Date.now();
  const verifiedAt = input.connection.lastVerifiedAt ? Date.parse(input.connection.lastVerifiedAt) : NaN;
  const expiresAt = input.connection.expiresAt ? Date.parse(input.connection.expiresAt) : nowMs + (policyValue?.max_age_ms ?? 0);
  if (!policyValue || input.connection.accountRef !== input.accountRef || !input.connection.status.match(/^verified$/u)
    || input.connection.verificationStatus !== "verified" || !["connected", "not_applicable"].includes(input.connection.oauthState)
    || !Number.isFinite(verifiedAt) || verifiedAt > nowMs || nowMs - verifiedAt > policyValue.max_age_ms
    || !Number.isFinite(expiresAt) || expiresAt <= nowMs) return null;
  return {
    schema: WORKFLOW_AUTHORIZATION_READBACK_SCHEMA,
    workflow_id: input.workflowId,
    policy_id: policyValue.policy_id,
    company_id: input.companyId,
    provider: input.connection.platform,
    account_ref: input.connection.accountRef,
    scope_digest: authorizationScopeDigest({ companyId: input.companyId, workflowId: input.workflowId, provider: input.connection.platform, accountRef: input.connection.accountRef, targetDigest: input.targetDigest, payloadHash: input.payloadHash }),
    verified_at: new Date(verifiedAt).toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
    status: "verified"
  };
}

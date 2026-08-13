import { createHash } from "node:crypto";
import type { TaskClass } from "./taskContract.js";

export const TRUST_BOUNDARY_SCHEMA_V1 = "automation_os_trust_boundary.v1" as const;
export const EFFECT_STATE_SCHEMA_V1 = "automation_os_effect_state.v1" as const;
export const EFFECT_LEDGER_SCHEMA_V1 = "automation_os_effect_ledger.v1" as const;
export const SAGA_SCHEMA_V1 = "automation_os_saga.v1" as const;
export const UNIVERSAL_TARGET_SCHEMA_V1 = "automation_os_universal_target.v1" as const;
export const PORTABLE_TASK_PACKAGE_SCHEMA_V1 = "automation_os_portable_task_package.v1" as const;
export const CROSS_WORKFLOW_LEDGER_SCHEMA_V1 = "automation_os_cross_workflow_ledger.v1" as const;
export const APPROVAL_TEMPLATE_SCHEMA_V1 = "automation_os_approval_template.v1" as const;
export const HUMAN_FRICTION_SLO_SCHEMA_V1 = "automation_os_human_friction_slo.v1" as const;

export type SourceTrust = "aos_source_of_truth" | "page_source" | "email_source" | "sns_source" | "inferred";
export type TrustedValueV1 = { field: string; source: SourceTrust; ref: string; sha256: string };
export type NegativeCapability = "no_billing" | "no_otp" | "no_captcha" | "no_identity_verification" | "no_tax" | "no_banking" | "no_foreign_company" | "no_unknown_required_fact" | "no_cross_account";
export type TrustBoundaryV1 = { schema: typeof TRUST_BOUNDARY_SCHEMA_V1; trusted_fields: readonly TrustedValueV1[]; page_fields: readonly TrustedValueV1[]; negative_capabilities: readonly NegativeCapability[]; effect_admitted: boolean; exact_blocker: string | null };

const HASH = /^[a-f0-9]{64}$/u;
const NEGATIVE_DEFAULTS: readonly NegativeCapability[] = ["no_billing", "no_otp", "no_captcha", "no_identity_verification", "no_tax", "no_banking", "no_foreign_company", "no_unknown_required_fact", "no_cross_account"];
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

export function enforceTrustedEffectInputs(input: { target: TrustedValueV1; account: TrustedValueV1; payload: TrustedValueV1; approval: TrustedValueV1; pageValues?: readonly TrustedValueV1[]; negativeCapabilities?: readonly NegativeCapability[] }): TrustBoundaryV1 {
  const trusted = [input.target, input.account, input.payload, input.approval];
  const trustedOnly = trusted.every((value) => value.source === "aos_source_of_truth" && HASH.test(value.sha256));
  const forbiddenPage = (input.pageValues ?? []).some((value) => ["target", "account", "payload", "approval", "authority", "secret"].includes(value.field));
  return { schema: TRUST_BOUNDARY_SCHEMA_V1, trusted_fields: trusted, page_fields: input.pageValues ?? [], negative_capabilities: input.negativeCapabilities ?? NEGATIVE_DEFAULTS, effect_admitted: trustedOnly && !forbiddenPage, exact_blocker: trustedOnly && !forbiddenPage ? null : "untrusted_page_data_cannot_change_effect_admission" };
}

export function verifyIdentityContinuity(input: { providerAccount: string; expectedAccount: string; company: string; expectedCompany: string; locale: string; expectedLocale: string; profileRef: string; expectedProfileRef: string }): { status: "matched" | "blocked"; exact_blocker: string | null } {
  const matched = input.providerAccount === input.expectedAccount && input.company === input.expectedCompany && input.locale === input.expectedLocale && input.profileRef === input.expectedProfileRef;
  return { status: matched ? "matched" : "blocked", exact_blocker: matched ? null : "provider_company_locale_profile_identity_continuity_mismatch" };
}

export type EffectState = "planned" | "admitted" | "executing" | "intent" | "confirmed" | "reconciled" | "closed";
export type EffectRecordV1 = { schema: typeof EFFECT_STATE_SCHEMA_V1; operation_key: string; task_id: string; target_hash: string; payload_hash: string; audience_hash: string; state: EffectState; external_action_executed: boolean; ambiguous: boolean; retry_forbidden: boolean; exact_blocker: string | null };
export type EffectEvent = "admit" | "start" | "intent_sent" | "confirmed" | "reconciled" | "closed" | "timeout" | "ambiguous";

export function operationKey(input: { taskId: string; targetHash: string; payloadHash: string; audienceHash: string; idempotencyKey: string }): string { return `operation_${digest(input).slice(0, 48)}`; }
export function transitionEffect(current: EffectRecordV1, event: EffectEvent): EffectRecordV1 {
  const valid: Record<EffectState, Partial<Record<EffectEvent, EffectState>>> = { planned: { admit: "admitted" }, admitted: { start: "executing" }, executing: { intent_sent: "intent" }, intent: { confirmed: "confirmed", timeout: "intent", ambiguous: "intent" }, confirmed: { reconciled: "reconciled" }, reconciled: { closed: "closed" }, closed: {}, };
  const next = valid[current.state][event];
  if (!next) throw new Error(`effect_transition_invalid:${current.state}:${event}`);
  const ambiguous = event === "timeout" || event === "ambiguous";
  return { ...current, state: next, ambiguous: current.ambiguous || ambiguous, retry_forbidden: current.retry_forbidden || ambiguous, exact_blocker: ambiguous ? "effect_ambiguous_reconciliation_required_no_replay" : next === "closed" ? null : current.exact_blocker };
}

export class EffectLedger {
  readonly schema = EFFECT_LEDGER_SCHEMA_V1;
  private readonly records = new Map<string, EffectRecordV1>();
  reserve(input: { taskId: string; targetHash: string; payloadHash: string; audienceHash: string; idempotencyKey: string }): { record: EffectRecordV1; replay: boolean } {
    const key = operationKey(input); const existing = this.records.get(key); if (existing) return { record: existing, replay: true };
    const record: EffectRecordV1 = { schema: EFFECT_STATE_SCHEMA_V1, operation_key: key, task_id: input.taskId, target_hash: input.targetHash, payload_hash: input.payloadHash, audience_hash: input.audienceHash, state: "planned", external_action_executed: false, ambiguous: false, retry_forbidden: false, exact_blocker: null };
    this.records.set(key, record); return { record, replay: false };
  }
  apply(operationKeyValue: string, event: EffectEvent): EffectRecordV1 { const record = this.records.get(operationKeyValue); if (!record) throw new Error("effect_ledger_operation_missing"); const next = transitionEffect(record, event); this.records.set(operationKeyValue, { ...next, external_action_executed: next.state !== "planned" && next.state !== "admitted" }); return this.records.get(operationKeyValue)!; }
  get(operationKeyValue: string): EffectRecordV1 | null { return this.records.get(operationKeyValue) ?? null; }
}

export type SagaStepV1 = { id: string; action: string; compensation: string; status: "pending" | "completed" | "compensated" | "blocked" };
export type SagaV1 = { schema: typeof SAGA_SCHEMA_V1; task_id: string; steps: SagaStepV1[]; status: "running" | "compensating" | "closed" | "blocked"; exact_blocker: string | null };
export function compensateSaga(saga: SagaV1, failedStepId: string): SagaV1 { const index = saga.steps.findIndex((step) => step.id === failedStepId); if (index < 0) return { ...saga, status: "blocked", exact_blocker: "saga_failed_step_missing" }; return { ...saga, status: "compensating", exact_blocker: "saga_compensation_in_progress", steps: saga.steps.map((step, stepIndex) => stepIndex < index && step.status === "completed" ? { ...step, status: "compensated" } : stepIndex === index ? { ...step, status: "blocked" } : step) }; }

export type UniversalTargetV1 = { schema: typeof UNIVERSAL_TARGET_SCHEMA_V1; provider: string; object_type: string; stable_id: string; url: string | null; audience: string; owner: string };
export function universalTarget(input: Omit<UniversalTargetV1, "schema">): UniversalTargetV1 { if (!input.provider || !input.object_type || !input.stable_id || !input.audience || !input.owner) throw new Error("universal_target_required"); return { schema: UNIVERSAL_TARGET_SCHEMA_V1, ...input }; }
export type MemoryKind = "task_memory" | "policy_profile_memory";
export type TaskMemoryV1 = { kind: "task_memory"; adapter_id: string; knowledge_ref: string; confidence: number; no_authority_reuse: true };
export type PolicyProfileMemoryV1 = { kind: "policy_profile_memory"; profile_ref: string; scope: string; confidence: number; authority_ref: string; };

export type PortableTaskPackageV1 = { schema: typeof PORTABLE_TASK_PACKAGE_SCHEMA_V1; version: string; migration_from: readonly string[]; task_dsl_version: string; adapter_version: string; policy_version: string; fixture_version: string; receipt_schema_version: string; task: Record<string, unknown>; adapter: Record<string, unknown>; policy: Record<string, unknown>; fixture_ref: string; no_secrets: true };
export function portableTaskPackage(input: Omit<PortableTaskPackageV1, "schema" | "no_secrets">): PortableTaskPackageV1 { const serialized = JSON.stringify(input); if (/(token|secret|password|cookie|otp|private.?key)/iu.test(serialized)) throw new Error("portable_task_package_secret_forbidden"); return { schema: PORTABLE_TASK_PACKAGE_SCHEMA_V1, ...input, no_secrets: true }; }

export type CrossWorkflowLedgerV1 = { schema: typeof CROSS_WORKFLOW_LEDGER_SCHEMA_V1; key: string; domains: readonly string[]; conflict: boolean; duplicate: boolean; operation_keys: readonly string[]; exact_blocker: string | null };
export function crossWorkflowLedger(input: { universalTarget: UniversalTargetV1; domains: readonly string[]; operationKeys: readonly string[] }): CrossWorkflowLedgerV1 { const unique = new Set(input.operationKeys); const duplicate = unique.size !== input.operationKeys.length; return { schema: CROSS_WORKFLOW_LEDGER_SCHEMA_V1, key: digest(input.universalTarget), domains: input.domains, conflict: false, duplicate, operation_keys: [...unique], exact_blocker: duplicate ? "cross_workflow_duplicate_operation_key" : null }; }

export type PlanDiffV1 = { changed: readonly ("target" | "account" | "payload" | "audience" | "effect_scope")[]; reapproval_required: boolean; exact_blocker: string | null };
export function planDiff(previous: Record<string, string>, next: Record<string, string>): PlanDiffV1 { const fields = ["target", "account", "payload", "audience", "effect_scope"] as const; const changed = fields.filter((field) => previous[field] !== next[field]); return { changed, reapproval_required: changed.length > 0, exact_blocker: changed.length ? "plan_diff_effect_binding_changed_reapproval_required" : null }; }

export type ApprovalTemplateV1 = { schema: typeof APPROVAL_TEMPLATE_SCHEMA_V1; template_id: string; target_scope: string; expires_at: string; max_effects: 0 | 1; effect_scope: string; reusable: false };
export function approvalTemplate(input: Omit<ApprovalTemplateV1, "schema" | "reusable">): ApprovalTemplateV1 { if (Date.parse(input.expires_at) <= Date.now() || input.max_effects > 1) throw new Error("approval_template_scope_or_expiry_invalid"); return { schema: APPROVAL_TEMPLATE_SCHEMA_V1, ...input, reusable: false }; }

export type HumanFrictionSloV1 = { schema: typeof HUMAN_FRICTION_SLO_SCHEMA_V1; first_action_ms: number | null; question_count: number; manual_intervention_ms: number; recovery_rate: number; wrong_target_count: 0; ambiguous_resubmit_count: 0; cleanup_residue_count: 0 };
export const newHumanFrictionSlo = (): HumanFrictionSloV1 => ({ schema: HUMAN_FRICTION_SLO_SCHEMA_V1, first_action_ms: null, question_count: 0, manual_intervention_ms: 0, recovery_rate: 0, wrong_target_count: 0, ambiguous_resubmit_count: 0, cleanup_residue_count: 0 });

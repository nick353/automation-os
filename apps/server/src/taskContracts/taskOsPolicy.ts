import { createHash } from "node:crypto";
import { classifyTaskRisk, fieldProvenance, type DeclarativeTaskDslV1, type FieldSource } from "./taskDsl.js";
import type { TaskClass } from "./taskContract.js";

export const SURFACE_ROUTER_SCHEMA_V1 = "automation_os_surface_router.v1" as const;
export const RISK_BUDGET_SCHEMA_V1 = "automation_os_risk_budget.v1" as const;
export const HANDOFF_SCHEMA_V1 = "automation_os_human_handoff.v1" as const;
export const OUTCOME_CONTRACT_SCHEMA_V1 = "automation_os_outcome_contract.v1" as const;
export const CHECKPOINT_SCHEMA_V1 = "automation_os_durable_checkpoint.v1" as const;
export const PRIVACY_POLICY_SCHEMA_V1 = "automation_os_privacy_policy.v1" as const;
export const TRACE_SCHEMA_V1 = "automation_os_unified_trace.v1" as const;
export const CANARY_RING_SCHEMA_V1 = "automation_os_canary_ring.v1" as const;
export const BACKPRESSURE_SCHEMA_V1 = "automation_os_backpressure.v1" as const;

export type ExecutionSurface = "api" | "connector" | "local" | "browser_use_cli" | "codex_app_browser";
export type SurfaceRouteV1 = { schema: typeof SURFACE_ROUTER_SCHEMA_V1; selected: ExecutionSurface | null; attempted: readonly ExecutionSurface[]; ui_required: boolean; exact_blocker: string | null; next_action: string };
export function routeSurface(input: { uiRequired: boolean; preferred?: ExecutionSurface; available: readonly ExecutionSurface[]; allowed: readonly ExecutionSurface[] }): SurfaceRouteV1 {
  const allowed = new Set(input.allowed); const candidates: Array<ExecutionSurface | undefined> = input.uiRequired ? [input.preferred, "browser_use_cli", "codex_app_browser"] : [input.preferred, "api", "connector", "local"];
  const attempted = candidates.filter((value, index): value is ExecutionSurface => Boolean(value) && candidates.indexOf(value) === index).filter((value) => allowed.has(value) && input.available.includes(value));
  const selected = attempted[0] ?? null;
  return { schema: SURFACE_ROUTER_SCHEMA_V1, selected, attempted, ui_required: input.uiRequired, exact_blocker: selected ? null : "canonical_surface_unavailable", next_action: selected ? `execute via ${selected}` : "provide an allowed canonical surface or continue at the next non-UI stage" };
}

export type RiskBudgetV1 = { schema: typeof RISK_BUDGET_SCHEMA_V1; task_id: string; max_effects: 0 | 1; max_minutes: number; max_amount_cents: number | null; allowed_domains: readonly string[]; allowed_accounts: readonly string[]; used_effects: number; used_minutes: number; used_amount_cents: number; status: "within_budget" | "stopped"; exact_blocker: string | null };
export function createRiskBudget(input: Omit<RiskBudgetV1, "schema" | "used_effects" | "used_minutes" | "used_amount_cents" | "status" | "exact_blocker">): RiskBudgetV1 { return { schema: RISK_BUDGET_SCHEMA_V1, ...input, used_effects: 0, used_minutes: 0, used_amount_cents: 0, status: "within_budget", exact_blocker: null }; }
export function consumeRiskBudget(budget: RiskBudgetV1, input: { effects?: number; minutes?: number; amountCents?: number; domain?: string; account?: string }): RiskBudgetV1 {
  const effects = budget.used_effects + (input.effects ?? 0); const minutes = budget.used_minutes + (input.minutes ?? 0); const amount = budget.used_amount_cents + (input.amountCents ?? 0);
  const exceeded = effects > budget.max_effects || minutes > budget.max_minutes || (budget.max_amount_cents !== null && amount > budget.max_amount_cents) || (input.domain !== undefined && !budget.allowed_domains.includes(input.domain)) || (input.account !== undefined && !budget.allowed_accounts.includes(input.account));
  return { ...budget, used_effects: effects, used_minutes: minutes, used_amount_cents: amount, status: exceeded ? "stopped" : "within_budget", exact_blocker: exceeded ? "risk_budget_exceeded_or_scope_mismatch" : null };
}

export type HumanHandoffV1 = { schema: typeof HANDOFF_SCHEMA_V1; question: string; reason: string; choices: readonly string[]; input_location: "chat" | "ui" | "secret_store"; restart_stage: string; same_run_resume: true; replay_effect: false };
export function createHumanHandoff(input: Omit<HumanHandoffV1, "schema" | "same_run_resume" | "replay_effect">): HumanHandoffV1 { if (!input.question || !input.reason || !input.restart_stage) throw new Error("human_handoff_fields_missing"); return { schema: HANDOFF_SCHEMA_V1, ...input, same_run_resume: true, replay_effect: false }; }

export type AccountProfileV1 = { provider: string; account_ref: string; resume_ref: string | null; resume_sha256: string | null; locale: string | null; audience: string | null; expires_at: string | null; status: "eligible" | "mismatch" | "expired" };
export function selectAccountProfile(pool: readonly AccountProfileV1[], condition: { provider: string; accountRef: string; locale?: string; audience?: string }): { status: "selected" | "blocked"; profile: AccountProfileV1 | null; exact_blocker: string | null } {
  const selected = pool.find((profile) => profile.provider === condition.provider && profile.account_ref === condition.accountRef && (!condition.locale || profile.locale === condition.locale) && (!condition.audience || profile.audience === condition.audience) && profile.status === "eligible" && (!profile.expires_at || Date.parse(profile.expires_at) > Date.now()));
  return selected ? { status: "selected", profile: selected, exact_blocker: null } : { status: "blocked", profile: null, exact_blocker: "account_profile_resume_locale_audience_mismatch_or_expired" };
}

export type OutcomeContractV1 = { schema: typeof OUTCOME_CONTRACT_SCHEMA_V1; task_class: TaskClass; expected_state_change: string; provider_receipt_required: true; source_sync_required: true; reconciliation_required: true; cleanup_required: true; visible_confirmation_required: boolean; forbidden_completion_signals: readonly ["queued", "preflight", "screenshot", "cleanup_only"] };
export function outcomeContract(taskClass: TaskClass, expectedStateChange: string): OutcomeContractV1 { return { schema: OUTCOME_CONTRACT_SCHEMA_V1, task_class: taskClass, expected_state_change: expectedStateChange, provider_receipt_required: true, source_sync_required: true, reconciliation_required: true, cleanup_required: true, visible_confirmation_required: taskClass === "external_effect", forbidden_completion_signals: ["queued", "preflight", "screenshot", "cleanup_only"] }; }

export type DurableCheckpointV1 = { schema: typeof CHECKPOINT_SCHEMA_V1; trace_id: string; run_id: string; stage: string; status: "running" | "blocked" | "complete"; exact_blocker: string | null; next_action: string; restart_point: string; proof: readonly string[]; external_action_executed: boolean; replay_forbidden: boolean };
export function checkpoint(input: Omit<DurableCheckpointV1, "schema" | "replay_forbidden">): DurableCheckpointV1 { return { schema: CHECKPOINT_SCHEMA_V1, ...input, replay_forbidden: input.external_action_executed }; }

export type PrivacyPolicyV1 = { schema: typeof PRIVACY_POLICY_SCHEMA_V1; allowed_artifacts: readonly string[]; retention_days: number; recording_allowed: boolean; forbidden: readonly ["token", "otp", "email_body", "personal_data", "application_answers", "password", "cookie"] };
export const defaultPrivacyPolicy: PrivacyPolicyV1 = { schema: PRIVACY_POLICY_SCHEMA_V1, allowed_artifacts: ["safe_digest", "stage_status", "receipt_digest", "source_sync_digest", "reconciliation_digest", "cleanup_status"], retention_days: 30, recording_allowed: false, forbidden: ["token", "otp", "email_body", "personal_data", "application_answers", "password", "cookie"] };

export type UnifiedTraceV1 = { schema: typeof TRACE_SCHEMA_V1; trace_id: string; task_id: string; events: readonly { kind: "browser" | "api" | "connector" | "hook" | "worker" | "approval" | "receipt"; stage: string; status: string; exact_blocker: string | null; proof: string | null }[]; readback: { current_stage: string; exact_blocker: string | null; next_action: string; restart_point: string; proof: readonly string[] } };
export function createTrace(traceId: string, taskId: string): UnifiedTraceV1 { return { schema: TRACE_SCHEMA_V1, trace_id: traceId, task_id: taskId, events: [], readback: { current_stage: "intent", exact_blocker: null, next_action: "compile_task_plan", restart_point: "intent", proof: [] } }; }
export function appendTrace(trace: UnifiedTraceV1, event: UnifiedTraceV1["events"][number], readback: UnifiedTraceV1["readback"]): UnifiedTraceV1 { return { ...trace, events: [...trace.events, event], readback }; }

export type CanaryRingStage = "fixture" | "no_effect" | "private_test" | "one_effect" | "production";
export type CanaryRingV1 = { schema: typeof CANARY_RING_SCHEMA_V1; adapter_id: string; stage: CanaryRingStage; external_action_executed: boolean; same_run_receipt: boolean; source_sync: boolean; reconciliation: boolean; cleanup: boolean; exact_blocker: string | null };
export function advanceCanaryRing(current: CanaryRingV1, requested: CanaryRingStage, proof: { externalActionExecuted: boolean; receipt: boolean; sourceSync: boolean; reconciliation: boolean; cleanup: boolean; privateTestApproved?: boolean }): CanaryRingV1 { const order: CanaryRingStage[] = ["fixture", "no_effect", "private_test", "one_effect", "production"]; if (order.indexOf(requested) !== order.indexOf(current.stage) + 1) return { ...current, exact_blocker: "canary_ring_stage_order_invalid" }; if (requested === "one_effect" || requested === "production") { if (!proof.privateTestApproved || proof.externalActionExecuted !== true) return { ...current, exact_blocker: "canary_ring_effect_promotion_proof_missing" }; } const complete = proof.receipt && proof.sourceSync && proof.reconciliation && proof.cleanup; return { ...current, stage: requested, external_action_executed: proof.externalActionExecuted, same_run_receipt: proof.receipt, source_sync: proof.sourceSync, reconciliation: proof.reconciliation, cleanup: proof.cleanup, exact_blocker: complete ? null : "canary_ring_completion_proof_missing" }; }

export type BackpressureV1 = { schema: typeof BACKPRESSURE_SCHEMA_V1; provider_rate_limit_ok: boolean; worker_load_ok: boolean; profile_lease_ok: boolean; port_lease_ok: boolean; concurrency_ok: boolean; status: "admitted" | "queued" | "blocked"; exact_blocker: string | null };
export function evaluateBackpressure(input: Omit<BackpressureV1, "schema" | "status" | "exact_blocker">): BackpressureV1 { const values = Object.values(input); const ok = values.every(Boolean); return { schema: BACKPRESSURE_SCHEMA_V1, ...input, status: ok ? "admitted" : "queued", exact_blocker: ok ? null : "backpressure_provider_worker_lease_or_concurrency" }; }

export function compileNaturalLanguagePolicy(text: string, context: { knownFields?: Partial<Record<string, { source: FieldSource; valueRef: string; sha256?: string; confidence?: number }>> } = {}): { status: "ready" | "needs_input" | "blocked"; task: DeclarativeTaskDslV1 | null; missing: string[]; question: string | null; exact_blocker: string | null } {
  const source = String(text || "");
  const verb = /投稿|publish|post/iu.test(source) ? "publish" : /応募|apply|submit/iu.test(source) ? "submit" : /下書き|draft/iu.test(source) ? "draft" : /更新|update|edit/iu.test(source) ? "update" : /読む|閲覧|read|inspect/iu.test(source) ? "read" : null;
  if (!verb) return { status: "needs_input", task: null, missing: ["intent"], question: "操作の目的を閲覧・下書き・更新・応募・投稿のどれかで指定してください。", exact_blocker: null };
  const target = context.knownFields?.target; const account = context.knownFields?.account; const payload = context.knownFields?.payload;
  const missing = [...(!target ? ["target"] : []), ...(!account ? ["account"] : []), ...((verb !== "read" && !payload) ? ["payload"] : [])];
  if (missing.length) return { status: "needs_input", task: null, missing: [missing[0]], question: `${missing[0]}を指定してください。既知のprofile/knowledge baseは自動利用し、推測はしません。`, exact_blocker: null };
  const field = (name: string, fallback: { source: FieldSource; valueRef: string; sha256?: string; confidence?: number }) => fieldProvenance({ field: name, source: fallback.source, valueRef: fallback.valueRef, valueSha256: fallback.sha256, confidence: fallback.confidence, effectEligible: fallback.source !== "inferred" });
  const task = { schema: "automation_os_task_dsl.v1" as const, task_id: `policy-${createHash("sha256").update(source).digest("hex").slice(0, 16)}`, workflow_id: "generic-task", objective: source.slice(0, 2000), intent: { verb, target_description: target!.valueRef }, inputs: [field("target", target!), field("account", account!), ...(payload ? [field("payload", payload!)] : [])], constraints: { max_effects: verb === "submit" || verb === "publish" ? 1 : 0, allowed_origins: [], required_capabilities: ["observe", "locate"], sources: [] }, completion: { provider_receipt: true, source_sync: true, reconciliation: true, cleanup: true, visible_confirmation: verb === "submit" || verb === "publish" } } as DeclarativeTaskDslV1;
  return { status: "ready", task, missing: [], question: null, exact_blocker: null };
}

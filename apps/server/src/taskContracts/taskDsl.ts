import { createHash } from "node:crypto";
import { taskGatePolicy, type TaskClass } from "./taskContract.js";

export const TASK_DSL_SCHEMA_V1 = "automation_os_task_dsl.v1" as const;
export const TASK_PLAN_SCHEMA_V1 = "automation_os_task_plan.v1" as const;
export const TASK_FIELD_PROVENANCE_SCHEMA_V1 = "automation_os_task_field_provenance.v1" as const;

export type FieldSource = "user_input" | "profile" | "current_page" | "provider_readback" | "inferred";
export type ProvenancedFieldV1 = { schema: typeof TASK_FIELD_PROVENANCE_SCHEMA_V1; field: string; source: FieldSource; confidence: number; value_ref: string; sha256: string; effect_eligible: boolean };
export type DeclarativeTaskDslV1 = {
  schema: typeof TASK_DSL_SCHEMA_V1;
  task_id: string;
  workflow_id: string;
  objective: string;
  intent: { verb: "read" | "draft" | "update" | "submit" | "publish" | "deploy" | "charge" | "permission_change"; target_description: string };
  inputs: readonly ProvenancedFieldV1[];
  constraints: { max_effects: number; allowed_origins: readonly string[]; required_capabilities: readonly string[]; sources: readonly string[] };
  completion: { provider_receipt: boolean; source_sync: boolean; reconciliation: boolean; cleanup: boolean; visible_confirmation: boolean };
};

export type TaskPlanNodeV1 = { id: string; kind: "capability_check" | "observe" | "locate" | "scroll" | "account" | "payload" | "preview" | "approval" | "action" | "provider_receipt" | "source_sync" | "reconciliation" | "cleanup"; depends_on: readonly string[]; required: boolean; status: "pending" | "preserved" | "blocked" | "complete"; skip_reason?: string };
export type TaskPlanV1 = { schema: typeof TASK_PLAN_SCHEMA_V1; task_id: string; workflow_id: string; task_class: TaskClass; nodes: readonly TaskPlanNodeV1[]; omitted: readonly string[]; exact_blocker: string | null; next_stage: string; restart_point: string };

const ID = /^[A-Za-z0-9][-_A-Za-z0-9.:]{0,179}$/u;
const REF = /^(?!.*(?:token|secret|password|cookie|authorization|localstorage|sessionstorage|artifact|tmp|file:|data:))[^\s]{1,512}$/iu;
const HASH = /^[a-f0-9]{64}$/u;

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function id(value: unknown, code: string): string { const normalized = String(value || ""); if (!ID.test(normalized)) throw new Error(code); return normalized; }

export function fieldProvenance(input: { field: string; source: FieldSource; valueRef: string; valueSha256?: string; confidence?: number; effectEligible?: boolean }): ProvenancedFieldV1 {
  const field = id(input.field, "task_field_name_invalid");
  const valueRef = String(input.valueRef || "");
  if (!REF.test(valueRef)) throw new Error("task_field_value_ref_invalid");
  const confidence = input.confidence ?? 1;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("task_field_confidence_invalid");
  const digest = input.valueSha256 ?? sha256(valueRef);
  if (!HASH.test(digest)) throw new Error("task_field_sha256_invalid");
  return { schema: TASK_FIELD_PROVENANCE_SCHEMA_V1, field, source: input.source, confidence, value_ref: valueRef, sha256: digest, effect_eligible: input.effectEligible ?? input.source !== "inferred" };
}

export function classifyTaskRisk(intent: DeclarativeTaskDslV1["intent"]): TaskClass {
  if (intent.verb === "read") return "read_only";
  if (intent.verb === "draft") return "reversible_update";
  if (intent.verb === "update") return "reversible_update";
  if (intent.verb === "submit" || intent.verb === "publish") return "external_effect";
  if (intent.verb === "deploy") return "deploy";
  if (intent.verb === "charge") return "permission_change";
  return "permission_change";
}

export function validateTaskDsl(input: unknown): DeclarativeTaskDslV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("task_dsl_missing");
  const value = input as DeclarativeTaskDslV1;
  if (value.schema !== TASK_DSL_SCHEMA_V1) throw new Error("task_dsl_schema_invalid");
  id(value.task_id, "task_dsl_task_id_invalid"); id(value.workflow_id, "task_dsl_workflow_id_invalid");
  if (!value.objective || value.objective.length > 2000 || !value.intent?.target_description) throw new Error("task_dsl_objective_invalid");
  if (!Array.isArray(value.inputs)) throw new Error("task_dsl_inputs_invalid");
  const names = new Set<string>();
  for (const field of value.inputs) {
    if (!field || field.schema !== TASK_FIELD_PROVENANCE_SCHEMA_V1 || names.has(field.field)) throw new Error("task_dsl_field_provenance_invalid");
    names.add(field.field); if (!HASH.test(field.sha256)) throw new Error("task_dsl_field_sha256_invalid");
    if (field.source === "inferred" && field.effect_eligible) throw new Error("task_dsl_inferred_effect_value_forbidden");
  }
  if (!value.constraints || value.constraints.max_effects < 0 || value.constraints.max_effects > 1) throw new Error("task_dsl_constraints_invalid");
  if (!value.completion || value.completion.cleanup !== true) throw new Error("task_dsl_cleanup_required");
  return value;
}

function node(id: string, kind: TaskPlanNodeV1["kind"], depends_on: string[], required = true, status: TaskPlanNodeV1["status"] = "pending", skip_reason?: string): TaskPlanNodeV1 { return { id, kind, depends_on, required, status, ...(skip_reason ? { skip_reason } : {}) }; }

export function compileTaskPlan(input: unknown): TaskPlanV1 {
  const dsl = validateTaskDsl(input);
  const taskClass = classifyTaskRisk(dsl.intent);
  const gates = taskGatePolicy(taskClass);
  const nodes: TaskPlanNodeV1[] = [node("capability_check", "capability_check", []), node("observe", "observe", ["capability_check"]), node("locate", "locate", ["observe"]), node("account", "account", ["capability_check"]), node("payload", "payload", ["account"]), node("cleanup", "cleanup", ["observe"], true)];
  if (dsl.constraints.required_capabilities.includes("scroll") || taskClass !== "read_only") nodes.push(node("scroll", "scroll", ["locate"]));
  const actionDepends = ["locate", "account", "payload", ...(nodes.some((candidate) => candidate.id === "scroll") ? ["scroll"] : [])];
  if (gates.preview_required) nodes.push(node("preview", "preview", actionDepends));
  if (gates.approval_required) nodes.push(node("approval", "approval", ["preview"]));
  nodes.push(node("action", "action", gates.approval_required ? ["approval"] : actionDepends));
  nodes.push(node("provider_receipt", "provider_receipt", ["action"]));
  nodes.push(node("source_sync", "source_sync", ["provider_receipt"]));
  nodes.push(node("reconciliation", "reconciliation", ["source_sync"]));
  const omitted = [
    ...(dsl.constraints.sources.includes("gmail") ? [] : ["gmail_stage"]),
    ...(!gates.g0_required ? ["G0"] : []),
    ...(!gates.g1_required ? ["G1"] : []),
    ...(taskClass === "read_only" ? ["approval_stage", "effect_preview"] : []),
    ...(taskClass !== "deploy" && taskClass !== "permission_change" ? ["release_stage"] : []),
  ];
  return { schema: TASK_PLAN_SCHEMA_V1, task_id: dsl.task_id, workflow_id: dsl.workflow_id, task_class: taskClass, nodes, omitted, exact_blocker: null, next_stage: "capability_check", restart_point: "fresh capability manifest and same-run observe" };
}

export function replanTaskPlan(plan: TaskPlanV1, input: { blockedNodeId: string; exactBlocker: string; completedNodeIds?: readonly string[] }): TaskPlanV1 {
  if (plan.schema !== TASK_PLAN_SCHEMA_V1) throw new Error("task_plan_schema_invalid");
  const completed = new Set(input.completedNodeIds ?? plan.nodes.filter((candidate) => candidate.status === "complete").map((candidate) => candidate.id));
  const blockedIndex = plan.nodes.findIndex((candidate) => candidate.id === input.blockedNodeId);
  if (blockedIndex < 0) throw new Error("task_plan_blocked_node_missing");
  const preserved = plan.nodes.map((candidate) => completed.has(candidate.id) ? { ...candidate, status: "preserved" as const } : candidate);
  const next = preserved.find((candidate) => !completed.has(candidate.id) && candidate.id !== "cleanup") ?? preserved.find((candidate) => candidate.id === "cleanup");
  return { ...plan, nodes: preserved.map((candidate) => candidate.id === input.blockedNodeId ? { ...candidate, status: "blocked" as const } : candidate), exact_blocker: input.exactBlocker, next_stage: next?.id ?? "cleanup", restart_point: `resume from ${next?.id ?? "cleanup"}; preserve completed dependencies and do not replay external action` };
}

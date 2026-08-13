import { createHash } from "node:crypto";

export const TASK_CONTRACT_SCHEMA_V1 = "automation_os_task_contract.v1" as const;
export const TASK_CONTRACT_LIFECYCLE_V1 = [
  "intent", "target", "account", "payload", "authority", "approval", "action",
  "provider_receipt", "source_sync", "reconciliation", "cleanup"
] as const;

export type TaskClass = "read_only" | "reversible_update" | "external_effect" | "release" | "deploy" | "permission_change";
export type TaskLifecycleStage = typeof TASK_CONTRACT_LIFECYCLE_V1[number];
export type TaskContractStatus = "draft" | "ready" | "approval_pending" | "running" | "blocked" | "completed";

export type TaskContractV1 = {
  schema: typeof TASK_CONTRACT_SCHEMA_V1;
  contract_id: string;
  task_id: string;
  workflow_id: string;
  task_class: TaskClass;
  lifecycle: typeof TASK_CONTRACT_LIFECYCLE_V1;
  intent: { kind: string; ref: string; digest: string };
  target: { ref: string; digest: string; audience: string; audience_digest: string };
  account: { ref: string; identity_digest: string };
  payload: { ref: string | null; digest: string | null; immutable: boolean };
  authority: { ref: string | null; digest: string | null; owner: string; scope: string };
  approval: {
    required: boolean;
    status: "not_required" | "pending" | "approved";
    action_kind: string | null;
    approval_id: string | null;
    preview: { target_digest: string; payload_digest: string | null; audience_digest: string };
  };
  action: { status: "not_started" | "admitted" | "executed" | "no_effect" | "blocked"; idempotency_key: string };
  provider_receipt: { required: boolean; status: "missing" | "received" | "no_effect"; ref: string | null; digest: string | null };
  source_sync: { required: boolean; status: "missing" | "synced" | "no_effect"; ref: string | null; digest: string | null };
  reconciliation: { required: boolean; status: "missing" | "reconciled" | "no_effect"; digest: string | null };
  cleanup: { required: boolean; status: "missing" | "verified"; digest: string | null };
  gates: TaskGatePolicyV1;
  status: TaskContractStatus;
  exact_blocker: string | null;
  restart_point: string | null;
};

export type TaskGatePolicyV1 = {
  g0_required: boolean;
  g1_required: boolean;
  approval_required: boolean;
  preview_required: boolean;
  external_action_allowed: boolean;
  reversible: boolean;
  fail_closed_on: readonly ["captcha", "otp", "identity_verification", "unknown_required_fact", "ambiguous_submit"];
};

const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][-_A-Za-z0-9.:]{0,179}$/u;
const REF = /^(?!.*(?:token|secret|password|cookie|otp|authorization|localstorage|sessionstorage|artifact|tmp|file:|data:|javascript:))[^\s]{1,512}$/iu;
const FAIL_CLOSED = ["captcha", "otp", "identity_verification", "unknown_required_fact", "ambiguous_submit"] as const;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function id(value: unknown, code: string): string {
  const normalized = String(value || "");
  if (!ID.test(normalized)) throw new Error(code);
  return normalized;
}

function hash(value: unknown, code: string): string {
  const normalized = String(value || "");
  if (!HASH.test(normalized)) throw new Error(code);
  return normalized;
}

function ref(value: unknown, code: string): string {
  const normalized = String(value || "");
  if (!REF.test(normalized)) throw new Error(code);
  return normalized;
}

export function taskGatePolicy(taskClass: TaskClass): TaskGatePolicyV1 {
  const highImpact = taskClass === "release" || taskClass === "deploy" || taskClass === "permission_change";
  const external = taskClass === "external_effect" || highImpact;
  return Object.freeze({
    g0_required: highImpact,
    g1_required: highImpact,
    approval_required: external,
    preview_required: external,
    external_action_allowed: external,
    reversible: taskClass === "reversible_update",
    fail_closed_on: FAIL_CLOSED,
  });
}

export function buildTaskContractPreview(input: {
  contract_id: string;
  task_id: string;
  workflow_id: string;
  task_class: TaskClass;
  intent_kind: string;
  intent_ref: string;
  target_ref: string;
  target_digest: string;
  account_ref: string;
  payload_ref?: string | null;
  payload_digest?: string | null;
  audience: string;
  owner: string;
  authority_ref?: string | null;
  authority_digest?: string | null;
  authority_scope?: string;
  idempotency_key: string;
}): TaskContractV1 {
  const contractId = id(input.contract_id, "task_contract_id_invalid");
  const taskId = id(input.task_id, "task_contract_task_id_invalid");
  const workflowId = id(input.workflow_id, "task_contract_workflow_id_invalid");
  const taskClass = input.task_class;
  if (!["read_only", "reversible_update", "external_effect", "release", "deploy", "permission_change"].includes(taskClass)) throw new Error("task_contract_class_invalid");
  const intentRef = ref(input.intent_ref, "task_contract_intent_ref_invalid");
  const targetRef = ref(input.target_ref, "task_contract_target_ref_invalid");
  const targetDigest = hash(input.target_digest, "task_contract_target_digest_invalid");
  const accountRef = ref(input.account_ref, "task_contract_account_ref_invalid");
  const audience = ref(input.audience, "task_contract_audience_invalid");
  const owner = ref(input.owner, "task_contract_owner_invalid");
  const idempotencyKey = id(input.idempotency_key, "task_contract_idempotency_key_invalid");
  const payloadRef = input.payload_ref === null || input.payload_ref === undefined ? null : ref(input.payload_ref, "task_contract_payload_ref_invalid");
  const payloadDigest = input.payload_digest === null || input.payload_digest === undefined ? null : hash(input.payload_digest, "task_contract_payload_digest_invalid");
  if (taskClass !== "read_only" && !payloadDigest) throw new Error("task_contract_payload_digest_required");
  const authorityRef = input.authority_ref === null || input.authority_ref === undefined ? null : ref(input.authority_ref, "task_contract_authority_ref_invalid");
  const authorityDigest = input.authority_digest === null || input.authority_digest === undefined ? null : hash(input.authority_digest, "task_contract_authority_digest_invalid");
  if (taskClass !== "read_only" && (!authorityRef || !authorityDigest)) throw new Error("task_contract_authority_required");
  const gates = taskGatePolicy(taskClass);
  const external = gates.external_action_allowed;
  const audienceDigest = sha256(audience);
  const intentDigest = sha256(JSON.stringify({ kind: input.intent_kind, ref: intentRef }));
  const identityDigest = sha256(accountRef);
  return {
    schema: TASK_CONTRACT_SCHEMA_V1,
    contract_id: contractId,
    task_id: taskId,
    workflow_id: workflowId,
    task_class: taskClass,
    lifecycle: TASK_CONTRACT_LIFECYCLE_V1,
    intent: { kind: ref(input.intent_kind, "task_contract_intent_kind_invalid"), ref: intentRef, digest: intentDigest },
    target: { ref: targetRef, digest: targetDigest, audience, audience_digest: audienceDigest },
    account: { ref: accountRef, identity_digest: identityDigest },
    payload: { ref: payloadRef, digest: payloadDigest, immutable: taskClass === "external_effect" || gates.g0_required },
    authority: { ref: authorityRef, digest: authorityDigest, owner, scope: ref(input.authority_scope || "task", "task_contract_authority_scope_invalid") },
    approval: {
      required: gates.approval_required,
      status: gates.approval_required ? "pending" : "not_required",
      action_kind: gates.approval_required ? "one_task_effect" : null,
      approval_id: null,
      preview: { target_digest: targetDigest, payload_digest: payloadDigest, audience_digest: audienceDigest },
    },
    action: { status: "not_started", idempotency_key: idempotencyKey },
    provider_receipt: { required: external, status: "missing", ref: null, digest: null },
    source_sync: { required: external, status: "missing", ref: null, digest: null },
    reconciliation: { required: external, status: "missing", digest: null },
    cleanup: { required: true, status: "missing", digest: null },
    gates,
    status: gates.approval_required ? "approval_pending" : "ready",
    exact_blocker: gates.approval_required ? "task_contract_effect_approval_pending" : null,
    restart_point: gates.approval_required ? "fresh target_payload_audience_preview_then_one_item_approval" : null,
  };
}

export function admitTaskContractEffect(contract: TaskContractV1, input: { approvalStatus?: "pending" | "approved"; failureSignal?: string | null } = {}): TaskContractV1 {
  const current = validateTaskContract(contract);
  const signal = String(input.failureSignal || "").toLowerCase();
  if (signal && FAIL_CLOSED.some((value) => signal.includes(value))) {
    return { ...current, status: "blocked", exact_blocker: `task_contract_fail_closed_${signal.replace(/[^a-z0-9_]+/gu, "_").slice(0, 80)}`, restart_point: "human resolution and fresh same-run observation" };
  }
  if (!current.gates.external_action_allowed) return { ...current, action: { ...current.action, status: "admitted" }, status: "running", exact_blocker: null, restart_point: null };
  const approvalStatus = input.approvalStatus || current.approval.status;
  if (approvalStatus !== "approved") return { ...current, status: "approval_pending", exact_blocker: "task_contract_effect_approval_pending", restart_point: "fresh target_payload_audience_preview_then_one_item_approval" };
  return { ...current, approval: { ...current.approval, status: "approved" }, action: { ...current.action, status: "admitted" }, status: "running", exact_blocker: null, restart_point: "same-run provider action and source readback" };
}

export function completeTaskContract(contract: TaskContractV1, update: Partial<Pick<TaskContractV1, "provider_receipt" | "source_sync" | "reconciliation" | "cleanup">> & { actionStatus?: "executed" | "no_effect" }): TaskContractV1 {
  const current = validateTaskContract(contract);
  if (!["executed", "no_effect"].includes(update.actionStatus || "")) throw new Error("task_contract_action_status_invalid");
  const next = { ...current, ...update, action: { ...current.action, status: update.actionStatus! } };
  if (next.cleanup.status !== "verified") return { ...next, status: "blocked", exact_blocker: "task_contract_cleanup_readback_missing", restart_point: "same-run terminal cleanup readback" };
  const noEffect = update.actionStatus === "no_effect";
  const receiptOk = next.provider_receipt.status === (noEffect ? "no_effect" : "received");
  const syncOk = next.source_sync.status === (noEffect ? "no_effect" : "synced");
  const reconOk = next.reconciliation.status === (noEffect ? "no_effect" : "reconciled");
  if (!receiptOk || !syncOk || !reconOk) return { ...next, status: "blocked", exact_blocker: "task_contract_completion_proof_missing", restart_point: "same-run receipt_source_sync_reconciliation readback; do not replay" };
  return { ...next, status: "completed", exact_blocker: null, restart_point: null };
}

export function isTaskContractComplete(contract: unknown): boolean {
  try { return validateTaskContract(contract).status === "completed"; } catch { return false; }
}

export function validateTaskContract(input: unknown): TaskContractV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("task_contract_missing");
  const value = input as TaskContractV1;
  if (value.schema !== TASK_CONTRACT_SCHEMA_V1) throw new Error("task_contract_schema_invalid");
  id(value.contract_id, "task_contract_id_invalid");
  id(value.task_id, "task_contract_task_id_invalid");
  id(value.workflow_id, "task_contract_workflow_id_invalid");
  if (!Array.isArray(value.lifecycle) || JSON.stringify(value.lifecycle) !== JSON.stringify(TASK_CONTRACT_LIFECYCLE_V1)) throw new Error("task_contract_lifecycle_invalid");
  const expected = taskGatePolicy(value.task_class);
  if (JSON.stringify(value.gates) !== JSON.stringify(expected)) throw new Error("task_contract_gate_policy_invalid");
  hash(value.target?.digest, "task_contract_target_digest_invalid");
  hash(value.target?.audience_digest, "task_contract_audience_digest_invalid");
  hash(value.account?.identity_digest, "task_contract_account_digest_invalid");
  if (value.payload?.digest !== null) hash(value.payload?.digest, "task_contract_payload_digest_invalid");
  if (value.authority?.digest !== null) hash(value.authority?.digest, "task_contract_authority_digest_invalid");
  id(value.action?.idempotency_key, "task_contract_idempotency_key_invalid");
  if (value.gates.external_action_allowed && value.approval?.status !== "approved" && value.status === "running") throw new Error("task_contract_running_without_approval");
  return value;
}

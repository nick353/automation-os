import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execSql, insert, makeId, nowIso, querySql, sqlValue } from "../db/client.js";
import type { PortableBusinessEffectStage } from "./portableWorkflowEntrypoint.js";
import { getPortableExternalBusinessPlan, validatePortableBusinessInputBundle } from "./portableExternalBusinessPlan.js";
import { isPortableLocalWorkflowId } from "./portableLocalWorkflow.js";
import {
  issuePortableExternalEffectAuthorityV1,
  validatePortableExternalEffectAuthorityV1,
  type PortableExternalEffectAuthorityV1
} from "./portableExternalEffectAuthority.js";
import {
  buildPortableExternalApprovalBinding,
  buildPortableTargetBoundApprovalReceipt,
  portableBusinessTargetDigest,
  portableExternalApprovalResourceLocks,
  validatePortableTargetBoundApprovalReceipt,
  type PortableTargetBoundApprovalReceiptV1
} from "./portableExternalApprovalBinding.js";

const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;
const ALLOWED_READ_ONLY_STAGES = new Set(["candidate_supply", "reference_readback"]);
const ALLOWED_EFFECT_STAGES = new Set(["one_candidate_submit", "publish", "business_execute"]);
const SECRET_KEY_PATTERN = /(token|cookie|password|secret|authorization|storage[_-]?state|credential|raw.?body|page.?body)/iu;

type PortableRemoteExecutionMode = "read_only" | "business_effect";

export type PortableRemoteClaim = {
  run_id: string;
  company_id: string;
  workflow_id: string;
  step_id: string;
  source_trigger: string;
  idempotency_key: string;
  read_only_stage: "candidate_supply" | "reference_readback" | null;
  execution_mode: PortableRemoteExecutionMode;
  business_effect_stage: PortableBusinessEffectStage | null;
  approval_id: string | null;
  approval_receipt: PortableTargetBoundApprovalReceiptV1 | null;
  input_bundle: Record<string, unknown> | null;
  input_bundle_sha256: string | null;
  target_digest: string | null;
  effect_authority: PortableExternalEffectAuthorityV1 | null;
  worker_id: string;
  lease_expires_at: string;
  external_action_executed: false;
  browser_surface: "browser_use_cli";
};

export type PortableRemoteReceipt = {
  status: "complete" | "partial" | "blocked";
  exact_blocker: string | null;
  external_action_executed: boolean;
  browser_surface: "browser_use_cli" | "local_worker";
  workflow_id: string;
  run_id: string;
  step_id: string;
  cleanup_verified: boolean;
  readback_verified: boolean;
  effects_mode: PortableRemoteExecutionMode;
  read_only_stage_bound: boolean;
  business_effect_stage?: PortableBusinessEffectStage;
  same_run_receipt: boolean;
  business_proof_verified: boolean;
  read_only_proof_verified: boolean;
  target_digest?: string;
  external_executor_status: string;
  input_bundle_sha256?: string;
  adapter_result?: Record<string, unknown>;
  business_proofs?: Record<string, unknown>;
  same_run_source_sync?: boolean;
  web_operation_lifecycle?: Record<string, unknown>;
  approval_receipt?: PortableTargetBoundApprovalReceiptV1;
  effect_authority_id?: string;
  effect_authority_sha256?: string;
};

type RunRow = { id: string; company_id: string | null; status: string; metadata_json: string; created_at: string };
type StepRow = { id: string; name: string; status: string; lane_id: string | null; metadata_json: string };

export type PortableMacWorkerApprovalRecovery = {
  requeued: boolean;
  reason: string;
  approval_id?: string;
};

function parseRecord(value: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function workerId(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!WORKER_ID_PATTERN.test(normalized)) throw new Error("portable_remote_worker_id_invalid");
  return normalized;
}

function readOnlyStage(metadata: Record<string, unknown>): "candidate_supply" | "reference_readback" | null {
  const invocation = isObject(metadata.portable_workflow_invocation) ? metadata.portable_workflow_invocation : {};
  const worker = isObject(metadata.portable_worker) ? metadata.portable_worker : {};
  const value = invocation.read_only_stage ?? worker.read_only_stage ?? metadata.read_only_stage;
  return typeof value === "string" && ALLOWED_READ_ONLY_STAGES.has(value)
    ? value as "candidate_supply" | "reference_readback"
    : null;
}

function businessEffectStage(metadata: Record<string, unknown>): PortableBusinessEffectStage | null {
  const invocation = isObject(metadata.portable_workflow_invocation) ? metadata.portable_workflow_invocation : {};
  const worker = isObject(metadata.portable_worker) ? metadata.portable_worker : {};
  const value = invocation.effect_stage ?? worker.effect_stage ?? metadata.effect_stage;
  return typeof value === "string" && ALLOWED_EFFECT_STAGES.has(value)
    ? value as PortableBusinessEffectStage
    : null;
}

function workflowId(metadata: Record<string, unknown>): string {
  const invocation = isObject(metadata.portable_workflow_invocation) ? metadata.portable_workflow_invocation : {};
  const worker = isObject(metadata.portable_worker) ? metadata.portable_worker : {};
  const value = invocation.workflow_id ?? worker.workflow_id ?? metadata.workflow_id;
  return typeof value === "string" ? value.trim() : "";
}

function inputBundle(metadata: Record<string, unknown>): Record<string, unknown> | null {
  const bundle = isObject(metadata.portable_input_bundle) ? metadata.portable_input_bundle : {};
  const input = bundle.input;
  if (!isObject(input)) return null;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SECRET_KEY_PATTERN.test(key)) throw new Error("portable_remote_input_bundle_secret_like_key");
    if (typeof value === "string" && value.length <= 1000) safe[key] = value;
    else if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) safe[key] = value;
    else throw new Error("portable_remote_input_bundle_invalid");
  }
  return safe;
}

function inputBundleSha256(metadata: Record<string, unknown>): string | null {
  const bundle = isObject(metadata.portable_input_bundle) ? metadata.portable_input_bundle : {};
  const value = bundle.sha256;
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : null;
}

function targetDigest(bundle: Record<string, unknown>): string {
  return portableBusinessTargetDigest(bundle);
}

function businessBundleReady(workflow: string, stage: PortableBusinessEffectStage, bundle: Record<string, unknown> | null): boolean {
  if (!bundle) return false;
  if (workflow === "job-application-manager" && stage !== "one_candidate_submit") return false;
  if (workflow === "daily-ai-research-publish-run" && stage !== "publish") return false;
  if (workflow === "nisenprints-daily-product-canva-printify-etsy-pinterest" && stage !== "business_execute") return false;
  return validatePortableBusinessInputBundle(workflow, bundle).ok;
}

type ClaimAdmission = {
  executionMode: PortableRemoteExecutionMode;
  readOnlyStage: "candidate_supply" | "reference_readback" | null;
  businessEffectStage: PortableBusinessEffectStage | null;
  approvalId: string | null;
  approvalReceipt: PortableTargetBoundApprovalReceiptV1 | null;
  inputBundleSha256: string | null;
  targetDigest: string | null;
};

function idempotencyKey(metadata: Record<string, unknown>, runId: string, stepId: string): string {
  const invocation = isObject(metadata.portable_workflow_invocation) ? metadata.portable_workflow_invocation : {};
  return typeof invocation.idempotency_key === "string" && invocation.idempotency_key.trim()
    ? invocation.idempotency_key.trim()
    : `${runId}:${stepId}`;
}

function issueEffectAuthority(input: {
  run: RunRow;
  step: StepRow;
  metadata: Record<string, unknown>;
  workflow: string;
  admission: ClaimAdmission;
  leaseExpiresAt: string;
}): PortableExternalEffectAuthorityV1 | null {
  if (input.admission.executionMode !== "business_effect") return null;
  if (!input.admission.approvalId || !input.admission.inputBundleSha256 || !input.admission.targetDigest || !input.admission.businessEffectStage) {
    throw new Error("portable_effect_authority_inputs_missing");
  }
  const bundle = inputBundle(input.metadata);
  const payloadHash = bundle && typeof bundle.payload_hash === "string" && /^[a-f0-9]{64}$/u.test(bundle.payload_hash)
    ? bundle.payload_hash
    : null;
  return issuePortableExternalEffectAuthorityV1({
    companyId: input.run.company_id || "",
    workflowId: input.workflow,
    runId: input.run.id,
    stepId: input.step.id,
    effectStage: input.admission.businessEffectStage,
    approvalId: input.admission.approvalId,
    idempotencyKey: idempotencyKey(input.metadata, input.run.id, input.step.id),
    targetDigest: input.admission.targetDigest,
    inputBundleSha256: input.admission.inputBundleSha256,
    payloadHash,
    leaseExpiresAt: input.leaseExpiresAt
  });
}

function approvedBusinessAdmission(input: {
  runId: string;
  companyId: string | null;
  workflow: string;
  bundleSha256: string;
  metadata: Record<string, unknown>;
  stepId: string;
}): { id: string; receipt: PortableTargetBoundApprovalReceiptV1 } | null {
  const stepId = input.stepId.trim();
  if (!stepId || !input.companyId) return null;
  const invocation = isObject(input.metadata.portable_workflow_invocation) ? input.metadata.portable_workflow_invocation : {};
  const effectStage = typeof invocation.effect_stage === "string" ? invocation.effect_stage : "";
  const idempotencyKey = typeof invocation.idempotency_key === "string" ? invocation.idempotency_key : "";
  const bundle = inputBundle(input.metadata);
  if (!effectStage || !idempotencyKey || !bundle) return null;
  let binding;
  try {
    binding = buildPortableExternalApprovalBinding({
      companyId: input.companyId,
      workflowId: input.workflow,
      runId: input.runId,
      stepId,
      effectStage,
      idempotencyKey,
      inputBundleSha256: input.bundleSha256,
      inputBundle: bundle
    });
  } catch {
    return null;
  }
  const locks = portableExternalApprovalResourceLocks({
    workflowId: input.workflow,
    inputBundleSha256: input.bundleSha256,
    targetDigest: binding.target_digest,
    idempotencyKey
  });
  const rows = querySql<{
    id: string;
    status: string;
    company_id: string | null;
    run_id: string | null;
    step_id: string | null;
    action_kind: string | null;
    policy_version: string | null;
    expires_at: string | null;
    decided_at: string | null;
    resource_locks_json: string;
  }>(
    `SELECT id, status, company_id, run_id, step_id, action_kind, policy_version, expires_at, decided_at, resource_locks_json
       FROM approvals WHERE run_id=${sqlValue(input.runId)} ORDER BY created_at ASC`
  );
  for (const row of rows) {
    if (row.status !== "approved"
      || row.company_id !== input.companyId
      || row.run_id !== input.runId
      || row.step_id !== stepId
      || row.action_kind !== effectStage
      || row.policy_version !== "automation_os_portable_external_approval_binding.v1"
      || (row.expires_at && Date.parse(row.expires_at) <= Date.now())) continue;
    let list: unknown[] = [];
    try {
      const parsed = JSON.parse(row.resource_locks_json || "[]") as unknown;
      if (Array.isArray(parsed)) list = parsed;
    } catch { /* malformed approval locks are not eligible */ }
    if (!locks.every((lock) => list.includes(lock))) continue;
    const receipt = buildPortableTargetBoundApprovalReceipt({
      approvalId: row.id,
      approvalStatus: "approved",
      decidedAt: row.decided_at,
      binding
    });
    return { id: row.id, receipt };
  }
  return null;
}

/**
 * Restore a portable business run to the Mac worker queue after its exact,
 * target-bound approval is decided. Approval is still required here; this
 * helper only repairs the state transition that makes the approved run
 * claimable. It deliberately refuses read-only, local, legacy, terminal, or
 * already-effected runs.
 */
export function requeuePortableMacWorkerAfterApproval(runId: string): PortableMacWorkerApprovalRecovery {
  const run = querySql<RunRow & { execution_source: string }>(
    `SELECT id, company_id, status, metadata_json, created_at, execution_source FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`
  )[0];
  if (!run) return { requeued: false, reason: "run_not_found" };
  if (run.execution_source !== "automation-os") return { requeued: false, reason: "execution_source_not_portable" };
  if (!new Set(["blocked", "waiting_approval", "queued"]).has(run.status)) {
    return { requeued: false, reason: "run_not_recoverable" };
  }

  const metadata = parseRecord(run.metadata_json);
  if (metadata.worker_protocol !== "mac_worker_polling_required" || metadata.worker_mode !== "queued_for_mac_worker") {
    return { requeued: false, reason: "mac_worker_queue_binding_missing" };
  }
  if (metadata.external_action_executed === true) {
    return { requeued: false, reason: "external_effect_already_executed" };
  }
  const workflow = workflowId(metadata);
  const stage = businessEffectStage(metadata);
  const bundle = inputBundle(metadata);
  const bundleSha = inputBundleSha256(metadata);
  if (!workflow || !stage || !businessBundleReady(workflow, stage, bundle) || !bundleSha) {
    return { requeued: false, reason: "portable_business_admission_missing" };
  }
  const step = querySql<StepRow>(
    `SELECT id, name, status, lane_id, metadata_json FROM run_steps WHERE run_id=${sqlValue(runId)} AND status IN ('blocked', 'waiting_approval', 'queued') ORDER BY id ASC LIMIT 1`
  )[0];
  if (!step) return { requeued: false, reason: "claimable_step_missing" };
  const approval = approvedBusinessAdmission({
    runId,
    companyId: run.company_id,
    workflow,
    bundleSha256: bundleSha,
    metadata,
    stepId: step.id
  });
  if (!approval) return { requeued: false, reason: "approved_target_bound_lock_missing" };

  const now = nowIso();
  const stepMetadata = parseRecord(step.metadata_json);
  const runWorkerLoop = isObject(metadata.worker_loop) ? metadata.worker_loop : {};
  const runMacWorker = isObject(metadata.mac_worker) ? metadata.mac_worker : {};
  const nextRunMetadata = {
    ...metadata,
    exact_blocker: null,
    approval_status: "approved",
    approval_id: approval.id,
    portable_target_bound_approval_receipt: approval.receipt,
    external_action_executed: false,
    worker_loop: {
      ...runWorkerLoop,
      status: "waiting_for_pickup",
      launchReason: "approval_decided_requeued",
      queuedAt: now,
      approvalId: approval.id,
      requiredCommand: "npm run worker:loop:stored"
    },
    mac_worker: {
      ...runMacWorker,
      status: "waiting_for_pickup",
      launchReason: "approval_decided_requeued",
      queuedAt: now,
      approvalId: approval.id,
      requiredCommand: "npm run worker:loop:stored"
    }
  };
  const nextStepMetadata = {
    ...stepMetadata,
    exact_blocker: null,
    approval_status: "approved",
    approval_id: approval.id,
    portable_target_bound_approval_receipt: approval.receipt,
    worker_mode: "waiting_for_mac_worker",
    external_action_executed: false
  };

  execSql(
    `UPDATE runs SET status='queued', metadata_json=${sqlValue(nextRunMetadata)}, updated_at=${sqlValue(now)}
       WHERE id=${sqlValue(runId)} AND execution_source='automation-os' AND status IN ('blocked', 'waiting_approval', 'queued');
     UPDATE run_steps SET status='queued', started_at=NULL, completed_at=NULL, metadata_json=${sqlValue(nextStepMetadata)}
       WHERE id=${sqlValue(step.id)} AND status IN ('blocked', 'waiting_approval', 'queued');
     UPDATE lanes SET status='active', progress=0, health='good', current_task='waiting for Mac worker pickup', updated_at=${sqlValue(now)}
       WHERE id=${sqlValue(step.lane_id ?? "")};`
  );

  const confirmed = querySql<{ status: string; step_status: string }>(
    `SELECT runs.status, run_steps.status AS step_status FROM runs JOIN run_steps ON run_steps.run_id=runs.id
      WHERE runs.id=${sqlValue(runId)} AND run_steps.id=${sqlValue(step.id)} LIMIT 1`
  )[0];
  if (confirmed?.status !== "queued" || confirmed.step_status !== "queued") {
    return { requeued: false, reason: "approval_recovery_state_not_confirmed", approval_id: approval.id };
  }
  insert("worker_events", {
    id: makeId("evt"),
    company_id: run.company_id,
    run_id: runId,
    step_id: step.id,
    lane_id: step.lane_id,
    event_type: "approval_decided_requeued_for_mac_worker",
    message: "Approved portable business run requeued for Mac worker pickup",
    created_at: now,
    metadata_json: {
      workflow_id: workflow,
      effect_stage: stage,
      approval_id: approval.id,
      input_bundle_sha256: bundleSha,
      external_action_executed: false
    }
  });
  return { requeued: true, reason: "approval_decided_requeued", approval_id: approval.id };
}

function claimAdmission(run: RunRow, metadata: Record<string, unknown>, workflow: string, stepId?: string): ClaimAdmission | null {
  const readOnly = readOnlyStage(metadata);
  if (readOnly) {
    // startPortableWorkflowRun persists the input artifact immediately after
    // the run row is created. Do not let a fast Mac poll claim the transient
    // row before the candidate-supply bundle and its digest are present.
    if (readOnly === "candidate_supply" && (!inputBundle(metadata) || !inputBundleSha256(metadata))) {
      return null;
    }
    return {
      executionMode: "read_only",
      readOnlyStage: readOnly,
      businessEffectStage: null,
      approvalId: null,
      approvalReceipt: null,
      inputBundleSha256: inputBundleSha256(metadata),
      targetDigest: null
    };
  }
  const stage = businessEffectStage(metadata);
  const bundle = inputBundle(metadata);
  const bundleSha = inputBundleSha256(metadata);
  if (!stage || !businessBundleReady(workflow, stage, bundle) || !bundleSha) {
    return null;
  }
  const approval = approvedBusinessAdmission({
    runId: run.id,
    companyId: run.company_id,
    workflow,
    bundleSha256: bundleSha,
    metadata,
    stepId: stepId || ""
  });
  if (!approval) {
    return null;
  }
  return {
    executionMode: "business_effect",
    readOnlyStage: null,
    businessEffectStage: stage,
    approvalId: approval.id,
    approvalReceipt: approval.receipt,
    inputBundleSha256: bundleSha,
    targetDigest: bundle ? targetDigest(bundle) : null
  };
}

function claimFromMetadata(input: { run: RunRow; step: StepRow; metadata: Record<string, unknown>; workerId: string; leaseExpiresAt: string; admission: ClaimAdmission; effectAuthority?: PortableExternalEffectAuthorityV1 | null }): PortableRemoteClaim {
  const invocation = isObject(input.metadata.portable_workflow_invocation) ? input.metadata.portable_workflow_invocation : {};
  const sourceTrigger = typeof invocation.source_trigger === "string" ? invocation.source_trigger : "automation_os_scheduler";
  const key = typeof invocation.idempotency_key === "string" ? invocation.idempotency_key : `${input.run.id}:${input.step.id}`;
  return {
    run_id: input.run.id,
    company_id: input.run.company_id || "",
    workflow_id: workflowId(input.metadata),
    step_id: input.step.id,
    source_trigger: sourceTrigger,
    idempotency_key: key,
    read_only_stage: input.admission.readOnlyStage,
    execution_mode: input.admission.executionMode,
    business_effect_stage: input.admission.businessEffectStage,
    approval_id: input.admission.approvalId,
    approval_receipt: input.admission.approvalReceipt,
    input_bundle: inputBundle(input.metadata),
    input_bundle_sha256: input.admission.inputBundleSha256,
    target_digest: input.admission.targetDigest,
    effect_authority: input.effectAuthority ?? null,
    worker_id: input.workerId,
    lease_expires_at: input.leaseExpiresAt,
    external_action_executed: false,
    browser_surface: "browser_use_cli"
  };
}

/**
 * A worker receipt is terminal evidence for the portable lane. If an older
 * worker loop left the run in queued/running state after writing that
 * evidence, never reclaim it and never retry the external effect. Reconcile
 * no-effect receipts to a terminal blocked state so the queue can advance;
 * receipts that report an external effect stay visible for explicit proof
 * reconciliation and are skipped here.
 */
function reconcileExistingPortableWorkerReceipt(run: RunRow, metadata: Record<string, unknown>): boolean {
  const existing = isObject(metadata.remote_worker_receipt) ? metadata.remote_worker_receipt : null;
  if (!existing) return false;
  if (existing.external_action_executed === true) return true;

  const step = querySql<StepRow>(`
    SELECT id, name, status, lane_id, metadata_json
    FROM run_steps
    WHERE run_id=${sqlValue(run.id)} AND status IN ('queued', 'running', 'waiting_approval')
    ORDER BY id ASC LIMIT 1
  `)[0];
  const timestamp = nowIso();
  const exactBlocker = typeof existing.exact_blocker === "string" && existing.exact_blocker.trim()
    ? existing.exact_blocker.trim().slice(0, 240)
    : "portable_remote_receipt_already_recorded";
  const alreadyReconciled = metadata.portable_remote_receipt_reconciled === true;
  if (!alreadyReconciled) {
    const workerLoop = isObject(metadata.worker_loop) ? metadata.worker_loop : {};
    const macWorker = isObject(metadata.mac_worker) ? metadata.mac_worker : {};
    const nextMetadata = {
      ...metadata,
      exact_blocker: exactBlocker,
      external_action_executed: false,
      portable_remote_receipt_reconciled: true,
      portable_remote_receipt_reconciled_at: timestamp,
      worker_loop: { ...workerLoop, status: "reconciled_blocked_receipt", reconciledAt: timestamp },
      mac_worker: { ...macWorker, status: "reconciled_blocked_receipt", reconciledAt: timestamp }
    };
    execSql(`UPDATE runs SET status='blocked', metadata_json=${sqlValue(nextMetadata)}, updated_at=${sqlValue(timestamp)} WHERE id=${sqlValue(run.id)} AND status IN ('queued', 'running', 'waiting_approval');`);
    if (step) {
      execSql(`UPDATE run_steps SET status='blocked', completed_at=${sqlValue(timestamp)}, metadata_json=${sqlValue({
        ...parseRecord(step.metadata_json),
        exact_blocker: exactBlocker,
        external_action_executed: false,
        portable_remote_receipt_reconciled: true
      })} WHERE id=${sqlValue(step.id)} AND status IN ('queued', 'running', 'waiting_approval');`);
      if (step.lane_id) {
        execSql(`UPDATE lanes SET status='blocked', progress=50, health='blocked', current_task=${sqlValue(exactBlocker)}, updated_at=${sqlValue(timestamp)} WHERE id=${sqlValue(step.lane_id)};`);
      }
      insert("worker_events", {
        id: makeId("evt"),
        company_id: run.company_id,
        run_id: run.id,
        step_id: step.id,
        lane_id: step.lane_id,
        event_type: "portable_remote_receipt_reconciled",
        message: "Existing no-effect portable worker receipt reconciled; external retry suppressed",
        created_at: timestamp,
        metadata_json: {
          exact_blocker: exactBlocker,
          external_action_executed: false,
          receipt_status: typeof existing.status === "string" ? existing.status : "unknown",
          receipt_artifact_present: typeof existing.artifact_uri === "string" && existing.artifact_uri.length > 0
        }
      });
    }
  }
  return true;
}

/**
 * An expired claim without a receipt is not safe to replay.  This is the
 * recovery boundary for a worker that disappeared after claim admission: the
 * run is terminally blocked with an explicit no-effect marker so the next
 * worker poll can move on without silently skipping it forever.
 */
function reconcileExpiredPortableWorkerClaim(run: RunRow, metadata: Record<string, unknown>): boolean {
  const claim = isObject(metadata.remote_worker_claim) ? metadata.remote_worker_claim : null;
  if (!claim || typeof claim.lease_expires_at !== "string") return false;
  const leaseExpiresAt = Date.parse(claim.lease_expires_at);
  if (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt > Date.now()) return false;
  const receipt = isObject(metadata.remote_worker_receipt) ? metadata.remote_worker_receipt : null;
  if (receipt || metadata.external_action_executed === true) return true;

  const step = querySql<StepRow>(`
    SELECT id, name, status, lane_id, metadata_json
    FROM run_steps
    WHERE run_id=${sqlValue(run.id)} AND status IN ('queued', 'running', 'waiting_approval')
    ORDER BY id ASC LIMIT 1
  `)[0];
  const timestamp = nowIso();
  const exactBlocker = "portable_remote_claim_expired_without_receipt";
  const workerLoop = isObject(metadata.worker_loop) ? metadata.worker_loop : {};
  const macWorker = isObject(metadata.mac_worker) ? metadata.mac_worker : {};
  const nextMetadata = {
    ...metadata,
    exact_blocker: exactBlocker,
    external_action_executed: false,
    portable_remote_claim_reconciled: true,
    portable_remote_claim_reconciled_at: timestamp,
    worker_loop: { ...workerLoop, status: "expired_claim_blocked", reconciledAt: timestamp },
    mac_worker: { ...macWorker, status: "expired_claim_blocked", reconciledAt: timestamp }
  };
  execSql(`UPDATE runs SET status='blocked', metadata_json=${sqlValue(nextMetadata)}, updated_at=${sqlValue(timestamp)} WHERE id=${sqlValue(run.id)} AND status IN ('queued', 'running', 'waiting_approval');`);
  if (step) {
    execSql(`UPDATE run_steps SET status='blocked', completed_at=${sqlValue(timestamp)}, metadata_json=${sqlValue({
      ...parseRecord(step.metadata_json),
      exact_blocker: exactBlocker,
      external_action_executed: false,
      portable_remote_claim_reconciled: true
    })} WHERE id=${sqlValue(step.id)} AND status IN ('queued', 'running', 'waiting_approval');`);
    if (step.lane_id) {
      execSql(`UPDATE lanes SET status='blocked', progress=50, health='blocked', current_task=${sqlValue(exactBlocker)}, updated_at=${sqlValue(timestamp)} WHERE id=${sqlValue(step.lane_id)};`);
    }
    insert("worker_events", {
      id: makeId("evt"),
      company_id: run.company_id,
      run_id: run.id,
      step_id: step.id,
      lane_id: step.lane_id,
      event_type: "portable_remote_claim_expired_reconciled",
      message: "Expired portable worker claim blocked without replay; no receipt was recorded",
      created_at: timestamp,
      metadata_json: {
        exact_blocker: exactBlocker,
        external_action_executed: false,
        lease_expires_at: claim.lease_expires_at,
        receipt_present: false
      }
    });
  }
  return true;
}

export function claimPortableMacWorker(input: { companyId: string; workerId: string; requestedRunId?: string | null }): PortableRemoteClaim | null {
  const companyId = input.companyId.trim();
  if (!companyId) throw new Error("company_id_required");
  const id = workerId(input.workerId);
  const requested = input.requestedRunId?.trim() || null;
  const rows = querySql<RunRow>(`
    SELECT id, company_id, status, metadata_json, created_at
    FROM runs
    WHERE status IN ('queued', 'running', 'waiting_approval')
      AND execution_source='automation-os'
      AND quarantined=0
      AND company_id=${sqlValue(companyId)}
      ${requested ? `AND id=${sqlValue(requested)}` : ""}
    ORDER BY created_at ASC, id ASC
    LIMIT 100
  `);
  for (const run of rows) {
    const metadata = parseRecord(run.metadata_json);
    if (metadata.worker_protocol !== "mac_worker_polling_required" || metadata.worker_mode !== "queued_for_mac_worker") {
      continue;
    }
    if (reconcileExistingPortableWorkerReceipt(run, metadata)) {
      continue;
    }
    if (reconcileExpiredPortableWorkerClaim(run, metadata)) {
      continue;
    }
    const workflow = workflowId(metadata);
    if (!workflow) continue;
    const step = querySql<StepRow>(`
      SELECT id, name, status, lane_id, metadata_json
      FROM run_steps
      WHERE run_id=${sqlValue(run.id)} AND status IN ('queued', 'running', 'waiting_approval')
      ORDER BY id ASC LIMIT 1
    `)[0];
    if (!step) {
      continue;
    }
    const admission = claimAdmission(run, metadata, workflow, step.id);
    if (!admission) continue;
    const existingClaim = isObject(metadata.remote_worker_claim) ? metadata.remote_worker_claim : null;
    if (existingClaim && typeof existingClaim.lease_expires_at === "string" && Date.parse(existingClaim.lease_expires_at) > Date.now()) {
      if (existingClaim.worker_id !== id) continue;
      const existingAuthority = isObject(existingClaim.portable_effect_authority)
        ? validatePortableExternalEffectAuthorityV1(existingClaim.portable_effect_authority, {
          company_id: companyId,
          workflow_id: workflow,
          run_id: run.id,
          step_id: step.id,
          approval_id: admission.approvalId ?? undefined,
          idempotency_key: idempotencyKey(metadata, run.id, step.id),
          target_digest: admission.targetDigest ?? undefined,
          input_bundle_sha256: admission.inputBundleSha256 ?? undefined
        })
        : null;
      if (admission.executionMode === "business_effect" && !existingAuthority) continue;
      return claimFromMetadata({
        run,
        step,
        metadata,
        workerId: id,
        leaseExpiresAt: existingClaim.lease_expires_at,
        admission,
        effectAuthority: existingAuthority
      });
    }
    const claimedAt = nowIso();
    const leaseExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    let effectAuthority: PortableExternalEffectAuthorityV1 | null = null;
    try {
      effectAuthority = issueEffectAuthority({ run, step, metadata, workflow, admission, leaseExpiresAt });
    } catch {
      continue;
    }
    const updatedMetadata = {
      ...metadata,
      remote_worker_claim: {
        schema: "automation_os_portable_remote_worker_claim.v1",
        worker_id: id,
        claimed_at: claimedAt,
        lease_expires_at: leaseExpiresAt,
        execution_mode: admission.executionMode,
        ...(admission.businessEffectStage ? { business_effect_stage: admission.businessEffectStage } : {}),
        ...(admission.approvalId ? { approval_id: admission.approvalId } : {}),
        ...(admission.approvalReceipt ? { approval_receipt: admission.approvalReceipt } : {}),
        ...(admission.inputBundleSha256 ? { input_bundle_sha256: admission.inputBundleSha256 } : {}),
        ...(admission.targetDigest ? { target_digest: admission.targetDigest } : {}),
        ...(effectAuthority ? { portable_effect_authority: effectAuthority } : {})
      },
      worker_loop: { ...(isObject(metadata.worker_loop) ? metadata.worker_loop : {}), status: "claimed_by_mac_worker", claimedAt: claimedAt },
      mac_worker: { ...(isObject(metadata.mac_worker) ? metadata.mac_worker : {}), status: "claimed_by_mac_worker", workerId: id, claimedAt: claimedAt }
    };
    execSql(`UPDATE runs SET status='running', metadata_json=${sqlValue(updatedMetadata)}, updated_at=${sqlValue(claimedAt)} WHERE id=${sqlValue(run.id)} AND status IN ('queued', 'running', 'waiting_approval') AND metadata_json=${sqlValue(run.metadata_json)};`);
    const confirmed = querySql<RunRow>(`SELECT id, company_id, status, metadata_json, created_at FROM runs WHERE id=${sqlValue(run.id)} LIMIT 1`)[0];
    const confirmedMetadata = parseRecord(confirmed?.metadata_json);
    const confirmedClaim = isObject(confirmedMetadata.remote_worker_claim) ? confirmedMetadata.remote_worker_claim : {};
    if (!confirmed || confirmedClaim.worker_id !== id || confirmedClaim.claimed_at !== claimedAt) continue;
    const confirmedAdmission = claimAdmission(confirmed, confirmedMetadata, workflow, step.id);
    if (!confirmedAdmission) continue;
    const confirmedAuthority = isObject(confirmedClaim.portable_effect_authority)
      ? validatePortableExternalEffectAuthorityV1(confirmedClaim.portable_effect_authority, {
        company_id: companyId,
        workflow_id: workflow,
        run_id: confirmed.id,
        step_id: step.id,
        approval_id: confirmedAdmission.approvalId ?? undefined,
        idempotency_key: idempotencyKey(confirmedMetadata, confirmed.id, step.id),
        target_digest: confirmedAdmission.targetDigest ?? undefined,
        input_bundle_sha256: confirmedAdmission.inputBundleSha256 ?? undefined
      })
      : null;
    if (confirmedAdmission.executionMode === "business_effect" && !confirmedAuthority) continue;
    return claimFromMetadata({ run: confirmed, step, metadata: confirmedMetadata, workerId: id, leaseExpiresAt, admission: confirmedAdmission, effectAuthority: confirmedAuthority });
  }
  return null;
}

function businessProofSatisfied(workflowId: string, input: Record<string, unknown>, adapterResult: Record<string, unknown>): boolean {
  if (workflowId === "job-application-manager") {
    return adapterResult.state === "submitted_confirmed"
      && adapterResult.sync_ok === true
      && adapterResult.ledger_finalized === true;
  }
  const plan = getPortableExternalBusinessPlan(workflowId);
  const runnerReceipt = isObject(input.runner_receipt) ? input.runner_receipt : null;
  const proofs = runnerReceipt && isObject(runnerReceipt.business_proofs)
    ? runnerReceipt.business_proofs
    : null;
  // Daily AI and NisenPrints must provide workflow-owned business proof, not
  // merely a generic child receipt.  The adapter is responsible for deriving
  // these booleans from visible business readback; this layer only admits the
  // normalized contract and binds it to the current run.
  if (!plan || !runnerReceipt || !proofs || input.same_run_receipt !== true || input.cleanup_verified !== true) return false;
  if (runnerReceipt.same_run_source_sync !== true) return false;
  return plan.required_business_proofs.every((proof) => proofs[proof] === true
    || (isObject(proofs[proof]) && proofs[proof].verified === true));
}

function businessOperationKind(workflowId: string): "submit" | "publish" {
  return workflowId === "job-application-manager" ? "submit" : "publish";
}

function validateBusinessWebOperationLifecycle(input: unknown, expected: {
  workflowId: string;
  runId: string;
  stepId: string;
  idempotencyKey: string;
  targetDigest: string | null;
  payloadHash: string | null;
  externalActionExecuted: boolean;
}): { valid: boolean; complete: boolean; lifecycle: Record<string, unknown> } {
  const lifecycle = isObject(input) ? sanitizeRecord(input, 0) : {};
  const operation = businessOperationKind(expected.workflowId);
  const state = lifecycle.state;
  const valid = lifecycle.schema === "automation_os_web_operation_lifecycle.v1"
    && (state === "blocked" || state === "effect_unknown" || state === "completed" || state === "cleaned")
    && lifecycle.status === (state === "completed" || state === "cleaned" ? "complete" : "blocked")
    && lifecycle.run_id === expected.runId
    && lifecycle.step_id === expected.stepId
    && lifecycle.idempotency_key === expected.idempotencyKey
    && lifecycle.operation === operation
    && lifecycle.target_digest === expected.targetDigest
    && lifecycle.payload_hash === expected.payloadHash
    && lifecycle.external_action_executed === expected.externalActionExecuted
    && typeof lifecycle.same_run_receipt === "boolean"
    && typeof lifecycle.readback_verified === "boolean"
    && typeof lifecycle.cleanup_verified === "boolean"
    && lifecycle.no_replay === true;
  const complete = valid
    && lifecycle.status === "complete"
    && (state === "completed" || state === "cleaned")
    && expected.externalActionExecuted
    && lifecycle.same_run_receipt === true
    && lifecycle.readback_verified === true
    && lifecycle.cleanup_verified === true
    && lifecycle.exact_blocker === null;
  return { valid, complete, lifecycle };
}

function safeReceipt(input: unknown, expected: {
  workflowId: string;
  runId: string;
  stepId: string;
  idempotencyKey: string;
  executionMode: PortableRemoteExecutionMode;
  readOnlyStage: "candidate_supply" | "reference_readback" | null;
  businessEffectStage: PortableBusinessEffectStage | null;
  targetDigest: string | null;
  effectAuthority: PortableExternalEffectAuthorityV1 | null;
  approvalReceipt: PortableTargetBoundApprovalReceiptV1 | null;
}): PortableRemoteReceipt {
  if (!isObject(input)) throw new Error("portable_remote_receipt_invalid");
  const status = input.status === "complete" || input.status === "partial" || input.status === "blocked" ? input.status : "blocked";
  const exactBlocker = input.exact_blocker === null || input.exact_blocker === undefined ? null : String(input.exact_blocker).slice(0, 240);
  const localWorkflow = isPortableLocalWorkflowId(expected.workflowId);
  const browserSurface = input.browser_surface === "browser_use_cli"
    ? "browser_use_cli"
    : localWorkflow && input.browser_surface === "local_worker"
      ? "local_worker"
      : null;
  if (!browserSurface) throw new Error("portable_remote_browser_surface_invalid");
  if (input.run_id !== expected.runId || input.step_id !== expected.stepId || input.workflow_id !== expected.workflowId) throw new Error("portable_remote_receipt_binding_mismatch");
  const adapterResult = isObject(input.adapter_result) ? sanitizeRecord(input.adapter_result, 0) : {};
  const reportedExternal = input.external_action_executed === true;
  const sameRunReceipt = input.same_run_receipt === true;
  const cleanupVerified = input.cleanup_verified === true;
  const readbackVerified = input.readback_verified === true;
  const businessProofVerified = expected.executionMode === "business_effect"
    ? businessProofSatisfied(expected.workflowId, input, adapterResult)
    : false;
  const webOperationLifecycle = expected.executionMode === "business_effect"
    ? validateBusinessWebOperationLifecycle(input.web_operation_lifecycle, {
      workflowId: expected.workflowId,
      runId: expected.runId,
      stepId: expected.stepId,
      idempotencyKey: expected.idempotencyKey,
      targetDigest: expected.targetDigest,
      payloadHash: expected.effectAuthority?.payload_hash ?? null,
      externalActionExecuted: reportedExternal,
    })
    : null;
  let approvalReceiptValid = expected.executionMode !== "business_effect";
  let reportedApprovalReceipt: PortableTargetBoundApprovalReceiptV1 | null = null;
  if (expected.executionMode === "business_effect" && expected.approvalReceipt) {
    try {
      reportedApprovalReceipt = validatePortableTargetBoundApprovalReceipt(input.approval_receipt, {
        company_id: expected.approvalReceipt.binding.company_id,
        workflow_id: expected.workflowId,
        run_id: expected.runId,
        step_id: expected.approvalReceipt.binding.step_id,
        effect_stage: expected.businessEffectStage ?? undefined,
        idempotency_key: expected.approvalReceipt.binding.idempotency_key,
        input_bundle_sha256: expected.approvalReceipt.binding.input_bundle_sha256,
        target_digest: expected.targetDigest ?? undefined
      });
      approvalReceiptValid = reportedApprovalReceipt.approval_id === expected.approvalReceipt.approval_id
        && reportedApprovalReceipt.binding_sha256 === expected.approvalReceipt.binding_sha256;
    } catch {
      approvalReceiptValid = false;
    }
  }
  const expectedEffectAuthoritySha256 = expected.effectAuthority
    ? createHash("sha256").update(`${JSON.stringify(expected.effectAuthority, null, 2)}\n`).digest("hex")
    : null;
  const reportedEffectsMode = input.effects_mode === "business_effect" || input.effects_mode === "read_only"
    ? input.effects_mode
    : null;
  if (reportedEffectsMode !== expected.executionMode) throw new Error("portable_remote_effects_mode_mismatch");
  if (expected.executionMode === "read_only" && reportedExternal) throw new Error("portable_remote_external_effect_reported");
  if (expected.executionMode === "read_only" && input.read_only_stage_bound !== true) throw new Error("portable_remote_read_only_stage_unbound");

  const nonEmptyPath = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0;
  const localReadOnlyProofVerified = localWorkflow
    && status === "complete"
    && exactBlocker === null
    && reportedExternal === false
    && input.read_only_stage_bound === true
    && sameRunReceipt
    && readbackVerified
    && cleanupVerified
    && adapterResult.local_workflow_receipt === true
    && adapterResult.execution_surface === "mac_local_worker";
  const readOnlyProofVerified = expected.executionMode === "read_only"
    && expected.readOnlyStage !== null
    && (localReadOnlyProofVerified || (
      status === "complete"
      && exactBlocker === null
      && reportedExternal === false
      && input.read_only_stage_bound === true
      && sameRunReceipt
      && readbackVerified
      && cleanupVerified
      && (expected.readOnlyStage === "candidate_supply"
      ? adapterResult.stage === "job_candidate_supply"
        && adapterResult.status === "ready"
        && adapterResult.ready === true
        && adapterResult.read_only === true
        && Number.isSafeInteger(adapterResult.candidate_count)
        && Number.isSafeInteger(adapterResult.requested_count)
        && Number(adapterResult.candidate_count) >= 0
        && Number(adapterResult.requested_count) >= 0
        && Number(adapterResult.candidate_count) >= Number(adapterResult.requested_count)
        && nonEmptyPath(adapterResult.artifact_uri)
        && nonEmptyPath(adapterResult.browser_authority_path)
        && nonEmptyPath(adapterResult.browser_flow_receipt_path)
        && nonEmptyPath(adapterResult.browser_flow_manifest_path)
        && adapterResult.cleanup_verified === true
        && adapterResult.browser_flow_status === "finalized"
      : adapterResult.reference_readback === true
        && isObject(adapterResult.browser_runtime_readback)
        && adapterResult.browser_runtime_readback.cleanup_verified === true
        && nonEmptyPath(adapterResult.browser_runtime_readback.effective_session)
        && nonEmptyPath(adapterResult.browser_runtime_readback.profile_root)
        && Number(adapterResult.browser_runtime_readback.reserved_port) > 0
        && adapterResult.browser_runtime_readback.flow_status === "finalized"
    )));

  let normalizedStatus: PortableRemoteReceipt["status"] = status;
  let normalizedBlocker = exactBlocker;
  if (expected.executionMode === "business_effect") {
    if (input.business_effect_stage !== expected.businessEffectStage) throw new Error("portable_remote_business_stage_mismatch");
    if (input.target_digest !== expected.targetDigest) throw new Error("portable_remote_business_target_mismatch");
    const authorityBindingValid = Boolean(expected.effectAuthority
      && expectedEffectAuthoritySha256
      && input.effect_authority_id === expected.effectAuthority.authority_id
      && input.effect_authority_sha256 === expectedEffectAuthoritySha256);
    if (!approvalReceiptValid) {
      normalizedStatus = "blocked";
      normalizedBlocker = "portable_target_bound_approval_receipt_missing_or_invalid";
    } else if (!authorityBindingValid) {
      normalizedStatus = "blocked";
      normalizedBlocker = "portable_remote_effect_authority_receipt_binding_invalid";
    } else if (!webOperationLifecycle?.valid) {
      normalizedStatus = "blocked";
      normalizedBlocker = "portable_remote_web_operation_lifecycle_invalid";
    } else if (authorityBindingValid && reportedExternal && (!businessProofVerified || !sameRunReceipt || !cleanupVerified || !webOperationLifecycle.complete)) {
      normalizedStatus = "blocked";
      normalizedBlocker = "portable_remote_business_receipt_reconciliation_required";
    } else if (authorityBindingValid && reportedExternal && (normalizedStatus !== "complete" || normalizedBlocker)) {
      normalizedStatus = "blocked";
      normalizedBlocker = "portable_remote_business_receipt_reconciliation_required";
    } else if (authorityBindingValid && !reportedExternal && normalizedStatus === "complete" && !normalizedBlocker) {
      normalizedStatus = "blocked";
      normalizedBlocker = "portable_remote_business_effect_not_confirmed";
    }
  }
  const result: PortableRemoteReceipt = {
    status: normalizedStatus,
    exact_blocker: normalizedBlocker,
    external_action_executed: reportedExternal,
    browser_surface: browserSurface,
    workflow_id: expected.workflowId,
    run_id: expected.runId,
    step_id: expected.stepId,
    cleanup_verified: cleanupVerified,
    readback_verified: readbackVerified,
    effects_mode: expected.executionMode,
    read_only_stage_bound: expected.executionMode === "read_only" && input.read_only_stage_bound === true,
    same_run_receipt: sameRunReceipt,
    business_proof_verified: businessProofVerified,
    read_only_proof_verified: readOnlyProofVerified,
    external_executor_status: typeof input.external_executor_status === "string" ? input.external_executor_status.slice(0, 240) : "unknown"
  };
  if (expected.businessEffectStage) result.business_effect_stage = expected.businessEffectStage;
  if (expected.targetDigest) result.target_digest = expected.targetDigest;
  if (expected.effectAuthority) result.effect_authority_id = expected.effectAuthority.authority_id;
  if (typeof input.input_bundle_sha256 === "string" && /^[a-f0-9]{64}$/u.test(input.input_bundle_sha256)) result.input_bundle_sha256 = input.input_bundle_sha256;
  if (isObject(input.adapter_result)) result.adapter_result = adapterResult;
  if (reportedApprovalReceipt) result.approval_receipt = reportedApprovalReceipt;
  if (isObject(input.runner_receipt)) {
    const runnerReceipt = sanitizeRecord(input.runner_receipt, 0);
    if (isObject(runnerReceipt.business_proofs)) result.business_proofs = runnerReceipt.business_proofs;
    if (runnerReceipt.same_run_source_sync === true) result.same_run_source_sync = true;
  }
  if (webOperationLifecycle?.valid) result.web_operation_lifecycle = webOperationLifecycle.lifecycle;
  if (expected.executionMode === "read_only" && !readOnlyProofVerified && !result.exact_blocker && result.status === "complete") {
    result.exact_blocker = "portable_remote_read_only_business_completion_proof_pending";
  }
  return result;
}

function sanitizeRecord(value: Record<string, unknown>, depth: number): Record<string, unknown> {
  if (depth > 3) return {};
  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value).slice(0, 60)) {
    if (SECRET_KEY_PATTERN.test(key)) continue;
    if (typeof raw === "string") result[key] = raw.slice(0, 1000);
    else if (typeof raw === "number" || typeof raw === "boolean" || raw === null) result[key] = raw;
    else if (isObject(raw)) result[key] = sanitizeRecord(raw, depth + 1);
    else if (Array.isArray(raw)) result[key] = raw.slice(0, 20).map((item) => typeof item === "string" ? item.slice(0, 300) : isObject(item) ? sanitizeRecord(item, depth + 1) : item);
  }
  return result;
}

function runtimeBindingForReceipt(
  stepMetadata: Record<string, unknown>,
  receipt: PortableRemoteReceipt,
): Record<string, unknown> | null {
  const existing = isObject(stepMetadata.service_readiness_runtime_binding)
    ? stepMetadata.service_readiness_runtime_binding
    : null;
  const adapterResult = isObject(receipt.adapter_result) ? receipt.adapter_result : null;
  const readback = adapterResult && isObject(adapterResult.browser_runtime_readback)
    ? adapterResult.browser_runtime_readback
    : null;
  if (!existing || !readback) return null;
  const effectiveSession = typeof readback.effective_session === "string"
    ? readback.effective_session.trim()
    : "";
  const profileRoot = typeof readback.profile_root === "string" && readback.profile_root.trim()
    ? readback.profile_root
    : existing.profile_root;
  const reservedPort = Number.isSafeInteger(Number(readback.reserved_port)) && Number(readback.reserved_port) > 0
    ? Number(readback.reserved_port)
    : existing.reserved_port;
  const verified = receipt.external_action_executed === false
    && effectiveSession.length > 0
    && readback.cleanup_verified === true;
  return {
    ...existing,
    effective_session_id: effectiveSession || existing.effective_session_id || null,
    profile_root: profileRoot,
    reserved_port: reservedPort,
    readback_status: verified ? "verified" : "blocked",
    status: verified ? "verified" : "blocked",
    exact_blocker: verified ? null : (existing.exact_blocker || "service_readiness_browser_use_runtime_readback_missing"),
    external_action_executed: receipt.external_action_executed,
  };
}

export function recordPortableMacWorkerReceipt(input: { companyId: string; workerId: string; runId: string; receipt: unknown }): { replayed: boolean; receipt: PortableRemoteReceipt; artifact_uri: string } {
  const run = querySql<RunRow>(`SELECT id, company_id, status, metadata_json, created_at FROM runs WHERE id=${sqlValue(input.runId)} LIMIT 1`)[0];
  if (!run || run.company_id !== input.companyId) throw new Error("portable_remote_run_scope_mismatch");
  const metadata = parseRecord(run.metadata_json);
  const claim = isObject(metadata.remote_worker_claim) ? metadata.remote_worker_claim : {};
  if (claim.worker_id !== workerId(input.workerId)) throw new Error("portable_remote_worker_claim_mismatch");
  const workflowId = workflowIdFromMetadata(metadata);
  const executionMode: PortableRemoteExecutionMode = claim.execution_mode === "business_effect" ? "business_effect" : "read_only";
  const effectStage = typeof claim.business_effect_stage === "string" && ALLOWED_EFFECT_STAGES.has(claim.business_effect_stage)
    ? claim.business_effect_stage as PortableBusinessEffectStage
    : null;
  const claimedTargetDigest = typeof claim.target_digest === "string" && /^[a-f0-9]{64}$/u.test(claim.target_digest)
    ? claim.target_digest
    : null;
  const step = querySql<StepRow>(`SELECT id, name, status, lane_id, metadata_json FROM run_steps WHERE run_id=${sqlValue(run.id)} ORDER BY id ASC LIMIT 1`)[0];
  if (!step) throw new Error("portable_remote_run_step_missing");
  const effectAuthority = executionMode === "business_effect" && isObject(claim.portable_effect_authority)
    ? validatePortableExternalEffectAuthorityV1(claim.portable_effect_authority, {
      company_id: input.companyId,
      workflow_id: workflowId,
      run_id: run.id,
      step_id: step?.id ?? "",
      approval_id: typeof claim.approval_id === "string" ? claim.approval_id : undefined,
      idempotency_key: idempotencyKey(metadata, run.id, step?.id ?? ""),
      target_digest: claimedTargetDigest ?? undefined,
      input_bundle_sha256: typeof claim.input_bundle_sha256 === "string" ? claim.input_bundle_sha256 : undefined
    })
    : null;
  const receipt = safeReceipt(input.receipt, {
    workflowId,
    runId: run.id,
    stepId: step.id,
    idempotencyKey: idempotencyKey(metadata, run.id, step.id),
    executionMode,
    readOnlyStage: readOnlyStage(metadata),
    businessEffectStage: effectStage,
    targetDigest: claimedTargetDigest,
    effectAuthority,
    approvalReceipt: executionMode === "business_effect" && isObject(claim.approval_receipt)
      ? claim.approval_receipt as PortableTargetBoundApprovalReceiptV1
      : null
  });
  const existing = isObject(metadata.remote_worker_receipt) ? metadata.remote_worker_receipt : null;
  if (existing) return { replayed: true, receipt: existing as PortableRemoteReceipt, artifact_uri: typeof existing.artifact_uri === "string" ? existing.artifact_uri : "" };
  const artifactRoot = resolve(process.env.AUTOMATION_OS_ARTIFACT_ROOT?.trim() || resolve(process.cwd(), "data", "artifacts"));
  const artifactPath = resolve(artifactRoot, run.id, "portable-remote-worker-receipt.v1.json");
  mkdirSync(resolve(artifactRoot, run.id), { recursive: true, mode: 0o700 });
  const artifact = { schema: "automation_os_portable_remote_worker_receipt.v1", ...receipt, worker_id: workerId(input.workerId), created_at: nowIso() };
  const bytes = `${JSON.stringify(artifact, null, 2)}\n`;
  writeFileSync(artifactPath, bytes, { flag: "wx", mode: 0o600 });
  chmodSync(artifactPath, 0o600);
  const artifactUri = `file://${artifactPath}`;
  const proofId = makeId("proof");
  const timestamp = nowIso();
  const stepMetadata = parseRecord(step.metadata_json);
  const runtimeBinding = runtimeBindingForReceipt(stepMetadata, receipt);
  const merged = {
    ...metadata,
    remote_worker_receipt: { ...receipt, worker_id: workerId(input.workerId), artifact_uri: artifactUri },
    remote_worker_claim: { ...claim, completed_at: timestamp },
    exact_blocker: receipt.exact_blocker,
    external_action_executed: receipt.external_action_executed,
    worker_loop: { ...(isObject(metadata.worker_loop) ? metadata.worker_loop : {}), status: receipt.status === "complete" ? (executionMode === "business_effect" ? "completed_business_effect" : "completed_readback") : "blocked", completedAt: timestamp },
    mac_worker: { ...(isObject(metadata.mac_worker) ? metadata.mac_worker : {}), status: receipt.status === "complete" ? (executionMode === "business_effect" ? "completed_business_effect" : "completed_readback") : "blocked", completedAt: timestamp }
  };
  const completed = receipt.status === "complete"
    && receipt.exact_blocker === null
    && ((executionMode === "business_effect" && receipt.external_action_executed === true)
      || (executionMode === "read_only" && receipt.external_action_executed === false && receipt.read_only_proof_verified === true));
  const stepStatus = completed ? "completed" : "blocked";
  const runStatus = completed ? "complete" : "blocked";
  const localWorkflow = isPortableLocalWorkflowId(workflowId);
  const executionLabel = localWorkflow
    ? "portable_local_remote_mac_worker"
    : executionMode === "business_effect" ? "portable_external_remote_mac_worker_business" : "portable_external_remote_mac_worker";
  const proofSummary = completed
    ? executionMode === "business_effect"
      ? "complete: submitted/readback/cleanup proof verified"
      : localWorkflow
        ? "complete: Mac local read-only artifact/readback/cleanup proof verified"
        : "complete: read-only artifact/readback/cleanup proof verified"
    : `blocked: ${receipt.exact_blocker || "portable_remote_read_only_business_completion_proof_pending"}`;
  execSql(`UPDATE run_steps SET status=${sqlValue(stepStatus)}, completed_at=${sqlValue(timestamp)}, metadata_json=${sqlValue({ ...stepMetadata, ...(runtimeBinding ? { service_readiness_runtime_binding: runtimeBinding } : {}), exact_blocker: receipt.exact_blocker, external_action_executed: receipt.external_action_executed, read_only_proof_verified: receipt.read_only_proof_verified, execution_mode: executionLabel, portable_external_receipt: receipt, portable_external_artifact: artifactUri, proof_summary: proofSummary })} WHERE id=${sqlValue(step.id)};`);
  if (step.lane_id) execSql(`UPDATE lanes SET status=${sqlValue(completed ? "completed" : "blocked")}, progress=${completed ? 100 : 50}, health=${sqlValue(completed ? "healthy" : "blocked")}, updated_at=${sqlValue(timestamp)} WHERE id=${sqlValue(step.lane_id)};`);
  execSql(`UPDATE runs SET status=${sqlValue(runStatus)}, updated_at=${sqlValue(timestamp)}, metadata_json=${sqlValue(merged)} WHERE id=${sqlValue(run.id)};`);
  insert("proofs", { id: proofId, run_id: run.id, step_id: step.id, company_id: run.company_id, proof_type: "worker_receipt", label: `${workflowId} remote Mac worker receipt`, uri: artifactUri, size_bytes: Buffer.byteLength(bytes), created_at: timestamp, metadata_json: { execution_mode: executionLabel, external_action_executed: receipt.external_action_executed, exact_blocker: receipt.exact_blocker, business_proof_verified: receipt.business_proof_verified, read_only_proof_verified: receipt.read_only_proof_verified } });
  insert("worker_events", { id: makeId("evt"), run_id: run.id, step_id: step.id, lane_id: step.lane_id, company_id: run.company_id, event_type: completed ? "worker_completed" : "worker_blocked", message: proofSummary, created_at: timestamp, metadata_json: { worker_id: workerId(input.workerId), execution_mode: executionLabel, external_action_executed: receipt.external_action_executed, exact_blocker: receipt.exact_blocker, read_only_proof_verified: receipt.read_only_proof_verified } });
  return { replayed: false, receipt, artifact_uri: artifactUri };
}

function workflowIdFromMetadata(metadata: Record<string, unknown>): string {
  const invocation = isObject(metadata.portable_workflow_invocation) ? metadata.portable_workflow_invocation : {};
  const worker = isObject(metadata.portable_worker) ? metadata.portable_worker : {};
  const value = invocation.workflow_id ?? worker.workflow_id ?? metadata.workflow_id;
  return typeof value === "string" ? value.trim() : "";
}

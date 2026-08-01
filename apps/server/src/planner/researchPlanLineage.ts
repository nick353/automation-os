import { makeId, nowIso, querySql, runSqlTransaction, sqlValue, type SqlTransactionStep } from "../db/client.js";
import { createApprovalRequest } from "../runs/approvalGate.js";
import { getResearchPlan, type ResearchPlanSnapshot, type ResearchSourceKey } from "./researchPlanner.js";

type RunRow = {
  company_id: string | null;
  status: string;
  metadata_json: string;
  updated_at: string;
};

type PreparedStepRow = {
  id: string;
  lane_id: string | null;
  metadata_json: string;
};

export type ResearchPlanProofCommit = {
  id: string;
  proofType: string;
  uri: string;
  createdAt: string;
};

let failAfterProofInsertForTests = false;
let failAfterPlanStartUpdateForTests = false;

export function setResearchPlanLineageFaultAfterProofForTests(enabled: boolean): void {
  failAfterProofInsertForTests = enabled;
}

export function setResearchPlanStartFaultAfterPlanUpdateForTests(enabled: boolean): void {
  failAfterPlanStartUpdateForTests = enabled;
}

export function commitResearchPlanStartedAtomic(plan: ResearchPlanSnapshot, runId: string): ResearchPlanSnapshot {
  const companyId = requireCompanyId(plan);
  const currentRun = readScopedRun(runId, companyId);
  const currentRunMetadata = parseJson<Record<string, unknown>>(currentRun.metadata_json, {});
  const preparedRun = currentRun.status === "preparing"
    && currentRunMetadata.research_plan_id === plan.id
    && currentRunMetadata.research_plan_start_phase === "prepared_unlinked";
  const preparedPlan = typeof currentRunMetadata.plan === "object" && currentRunMetadata.plan
    ? currentRunMetadata.plan as Record<string, unknown>
    : {};
  const activatedRunStatus = preparedRun
    ? preparedPlan.approvalRequired === true ? "waiting_approval" : "queued"
    : undefined;
  const updatedAt = nowIso();
  const updatedPlan: ResearchPlanSnapshot = {
    ...plan,
    status: "started",
    runId,
    updatedAt,
    metadata: {
      ...plan.metadata,
      startedRunId: runId,
      snapshotRole: "pre_start_plan_evidence_not_completion_proof"
    }
  };
  const runUpdate = buildRunBoundaryUpdate({
    runId,
    companyId,
    currentRun,
    plan: updatedPlan,
    additionalProofType: undefined,
    metadata: {
      ...currentRunMetadata,
      research_plan_start_phase: "linked",
      research_plan_snapshot: {
        ...updatedPlan,
        snapshotRole: "pre_start_plan_evidence_not_completion_proof"
      }
    },
    desiredStatus: activatedRunStatus
  });
  const steps: SqlTransactionStep[] = [
    {
      sql: `UPDATE research_plans
            SET status='started', run_id=${sqlValue(runId)}, updated_at=${sqlValue(updatedAt)}, metadata_json=${sqlValue(updatedPlan.metadata)}
            WHERE id=${sqlValue(plan.id)} AND company_id=${sqlValue(companyId)}
              AND updated_at=${sqlValue(plan.updatedAt)} AND status=${sqlValue(plan.status)}`,
      expectChanges: 1
    }
  ];
  if (failAfterPlanStartUpdateForTests) {
    steps.push({
      sql: `UPDATE research_plans SET updated_at=updated_at WHERE id='__research_plan_start_lineage_fault__'`,
      expectChanges: 1
    });
  }
  if (preparedRun) steps.push(...buildPreparedRunActivationSteps(runId, companyId));
  steps.push(runUpdate);
  if (preparedRun && preparedPlan.approvalRequired === true) {
    const approval = createApprovalRequest({
      runId,
      title: `Approve command run: ${String(currentRunMetadata.command ?? plan.command).slice(0, 80)}`,
      requestedBy: "control-panel",
      approvalGroupId: `${runId}_approval_group`,
      resourceLocks: Array.isArray(preparedPlan.approvalResources)
        ? preparedPlan.approvalResources.filter((resource): resource is string => typeof resource === "string")
        : [],
      priority: "high"
    });
    steps.push({
      sql: `INSERT INTO approvals
            (id, run_id, title, requested_by, status, priority, company_id, approval_group_id, resource_locks_json, created_at, decided_at, decision_note)
            VALUES (${sqlValue(approval.id)}, ${sqlValue(approval.runId)}, ${sqlValue(approval.title)},
                    ${sqlValue(approval.requestedBy)}, ${sqlValue(approval.status)}, ${sqlValue(approval.priority)},
                    ${sqlValue(companyId)}, ${sqlValue(approval.approvalGroupId)}, ${sqlValue(approval.resourceLocks)},
                    ${sqlValue(approval.createdAt)}, NULL, NULL)`,
      expectChanges: 1
    });
  }
  runSqlTransaction(steps);
  return getResearchPlan(plan.id, [companyId]) ?? updatedPlan;
}

export function rollbackPreparedResearchPlanRunAtomic(input: {
  planId: string;
  runId: string;
  companyId: string;
}): void {
  const run = querySql<RunRow>(`
    SELECT company_id, status, metadata_json, updated_at FROM runs
    WHERE id=${sqlValue(input.runId)} AND company_id=${sqlValue(input.companyId)} LIMIT 1
  `)[0];
  if (!run) return;
  const metadata = parseJson<Record<string, unknown>>(run.metadata_json, {});
  if (metadata.research_plan_id !== input.planId || metadata.research_plan_start_phase !== "prepared_unlinked") {
    throw new Error("research_plan_prepared_run_cleanup_identity_mismatch");
  }
  if (run.status !== "preparing") {
    throw new Error("research_plan_prepared_run_cleanup_status_mismatch");
  }
  const scopedRun = `run_id=${sqlValue(input.runId)} AND company_id=${sqlValue(input.companyId)}`;
  runSqlTransaction([
    { sql: `DELETE FROM worker_events WHERE ${scopedRun}` },
    { sql: `DELETE FROM proofs WHERE ${scopedRun}` },
    { sql: `DELETE FROM approvals WHERE ${scopedRun}` },
    { sql: `DELETE FROM child_runs WHERE parent_run_id=${sqlValue(input.runId)}` },
    { sql: `DELETE FROM run_steps WHERE ${scopedRun}` },
    { sql: `DELETE FROM lanes WHERE run_id=${sqlValue(input.runId)}` },
    {
      sql: `DELETE FROM runs
            WHERE id=${sqlValue(input.runId)} AND company_id=${sqlValue(input.companyId)}
              AND status=${sqlValue(run.status)} AND updated_at=${sqlValue(run.updated_at)}
              AND metadata_json=${sqlValue(run.metadata_json)}`,
      expectChanges: 1
    }
  ]);
}

function buildPreparedRunActivationSteps(runId: string, companyId: string): SqlTransactionStep[] {
  const steps = querySql<PreparedStepRow>(`
    SELECT id, lane_id, metadata_json FROM run_steps
    WHERE run_id=${sqlValue(runId)} AND company_id=${sqlValue(companyId)}
    ORDER BY id ASC
  `);
  const transactionSteps: SqlTransactionStep[] = [];
  for (const step of steps) {
    const metadata = parseJson<Record<string, unknown>>(step.metadata_json, {});
    const requiresApproval = metadata.requires_approval === true;
    transactionSteps.push({
      sql: `UPDATE run_steps
            SET status=${sqlValue(requiresApproval ? "waiting_approval" : "queued")}, started_at=NULL
            WHERE id=${sqlValue(step.id)} AND run_id=${sqlValue(runId)}
              AND company_id=${sqlValue(companyId)} AND status='preparing'`,
      expectChanges: 1
    });
    if (step.lane_id) {
      const collisions = Array.isArray(metadata.collision_with) ? metadata.collision_with : [];
      transactionSteps.push({
        sql: `UPDATE lanes
              SET status=${sqlValue(requiresApproval ? "blocked" : "active")},
                  progress=${requiresApproval ? 0 : 10},
                  health=${sqlValue(collisions.length > 0 ? "collision" : requiresApproval ? "approval_required" : "good")}
              WHERE id=${sqlValue(step.lane_id)} AND run_id=${sqlValue(runId)}
                AND status='blocked' AND health='preparing'`,
        expectChanges: 1
      });
    }
  }
  return transactionSteps;
}

export function commitResearchPlanCaptureAtomic(input: {
  plan: ResearchPlanSnapshot;
  sourceKey: Extract<ResearchSourceKey, "web" | "youtube">;
  uri: string;
  label: string;
  sizeBytes: number;
  proofMetadata: Record<string, unknown>;
  artifactPath?: string;
  summary?: string;
}): { plan: ResearchPlanSnapshot; proof: ResearchPlanProofCommit } {
  const { plan, sourceKey } = input;
  if (!plan.runId) throw new Error("research_plan_run_required");
  const companyId = requireCompanyId(plan);
  const currentRun = readScopedRun(plan.runId, companyId);
  const proofType = sourceKey === "web" ? "readable_source_snapshot:web" : "visible_source_snapshot:youtube";
  const existing = querySql<{ id: string; proof_type: string; uri: string; created_at: string }>(`
    SELECT id, proof_type, uri, created_at FROM proofs
    WHERE run_id=${sqlValue(plan.runId)} AND company_id=${sqlValue(companyId)}
      AND proof_type=${sqlValue(proofType)} AND uri=${sqlValue(input.uri)}
    LIMIT 1
  `)[0];
  const createdAt = nowIso();
  const proof: ResearchPlanProofCommit = existing
    ? { id: existing.id, proofType: existing.proof_type, uri: existing.uri, createdAt: existing.created_at }
    : { id: makeId("proof"), proofType, uri: input.uri, createdAt };
  const latestCaptures = typeof plan.metadata.latestCaptures === "object" && plan.metadata.latestCaptures
    ? plan.metadata.latestCaptures as Record<string, unknown>
    : {};
  const updatedPlan: ResearchPlanSnapshot = {
    ...plan,
    updatedAt: createdAt,
    metadata: {
      ...plan.metadata,
      latestCaptures: {
        ...latestCaptures,
        [sourceKey]: {
          ok: true,
          status: "captured",
          proofId: proof.id,
          artifactPath: input.artifactPath,
          summary: input.summary,
          capturedAt: createdAt,
          proofState: "proof_saved"
        }
      }
    }
  };
  const steps: SqlTransactionStep[] = [];
  if (!existing) {
    steps.push({
      sql: `INSERT INTO proofs
            (id, company_id, run_id, step_id, proof_type, label, uri, size_bytes, created_at, metadata_json)
            VALUES (${sqlValue(proof.id)}, ${sqlValue(companyId)}, ${sqlValue(plan.runId)}, NULL,
                    ${sqlValue(proof.proofType)}, ${sqlValue(input.label)}, ${sqlValue(proof.uri)},
                    ${sqlValue(input.sizeBytes)}, ${sqlValue(proof.createdAt)}, ${sqlValue(input.proofMetadata)})`,
      expectChanges: 1
    });
  }
  if (failAfterProofInsertForTests) {
    steps.push({
      sql: `UPDATE research_plans SET updated_at=updated_at WHERE id='__research_plan_lineage_fault__'`,
      expectChanges: 1
    });
  }
  steps.push(buildRunBoundaryUpdate({
    runId: plan.runId,
    companyId,
    currentRun,
    plan: updatedPlan,
    additionalProofType: proofType,
    metadata: parseJson<Record<string, unknown>>(currentRun.metadata_json, {})
  }));
  steps.push({
    sql: `UPDATE research_plans
          SET updated_at=${sqlValue(createdAt)}, metadata_json=${sqlValue(updatedPlan.metadata)}
          WHERE id=${sqlValue(plan.id)} AND company_id=${sqlValue(companyId)}
            AND updated_at=${sqlValue(plan.updatedAt)} AND status=${sqlValue(plan.status)}
            AND run_id=${sqlValue(plan.runId)}`,
    expectChanges: 1
  });
  runSqlTransaction(steps);
  return { plan: getResearchPlan(plan.id, [companyId]) ?? updatedPlan, proof };
}

function buildRunBoundaryUpdate(input: {
  runId: string;
  companyId: string;
  currentRun: RunRow;
  plan: ResearchPlanSnapshot;
  additionalProofType?: string;
  metadata: Record<string, unknown>;
  desiredStatus?: string;
}): SqlTransactionStep {
  const requiredProofs = requiredResearchPlanProofs(input.plan);
  const approvalBoundarySources = billingRequiredResearchSourceKeys(input.plan);
  const presentProofs = querySql<{ proof_type: string }>(`
    SELECT proof_type FROM proofs
    WHERE run_id=${sqlValue(input.runId)} AND company_id=${sqlValue(input.companyId)}
  `).map((proof) => proof.proof_type);
  if (input.additionalProofType && !presentProofs.includes(input.additionalProofType)) presentProofs.push(input.additionalProofType);
  const missingProofs = requiredProofs.filter((proof) => !presentProofs.includes(proof));
  const shouldHoldPartial = (missingProofs.length > 0 || approvalBoundarySources.length > 0) && input.currentRun.status === "complete";
  const metadata = requiredProofs.length === 0 && approvalBoundarySources.length === 0
    ? input.metadata
    : {
        ...input.metadata,
        research_plan_required_proofs: requiredProofs,
        research_plan_missing_proofs: missingProofs,
        research_plan_billing_boundary_sources: approvalBoundarySources,
        proof_gate: {
          ...(typeof input.metadata.proof_gate === "object" && input.metadata.proof_gate ? input.metadata.proof_gate : {}),
          ok: missingProofs.length === 0 && approvalBoundarySources.length === 0,
          missing: missingProofs,
          present: presentProofs,
          reason: "research_plan_visible_source_proof_required"
        },
        ...(shouldHoldPartial ? { stop_reason: "research_plan_visible_source_proof_missing" } : {})
      };
  return {
    sql: `UPDATE runs
          SET status=${sqlValue(shouldHoldPartial ? "partial" : input.desiredStatus ?? input.currentRun.status)},
              updated_at=${sqlValue(nowIso())}, metadata_json=${sqlValue(metadata)}
          WHERE id=${sqlValue(input.runId)} AND company_id=${sqlValue(input.companyId)}
            AND status=${sqlValue(input.currentRun.status)}
            AND updated_at=${sqlValue(input.currentRun.updated_at)}
            AND metadata_json=${sqlValue(input.currentRun.metadata_json)}`,
    expectChanges: 1
  };
}

function readScopedRun(runId: string, companyId: string): RunRow {
  const run = querySql<RunRow>(`
    SELECT company_id, status, metadata_json, updated_at FROM runs
    WHERE id=${sqlValue(runId)} AND company_id=${sqlValue(companyId)} LIMIT 1
  `)[0];
  if (!run) throw new Error("research_plan_run_company_mismatch");
  return run;
}

function requireCompanyId(plan: ResearchPlanSnapshot): string {
  const companyId = plan.companyId?.trim() ?? "";
  if (!companyId) throw new Error("research_plan_company_required");
  return companyId;
}

function requiredResearchPlanProofs(plan: ResearchPlanSnapshot): string[] {
  return plan.sources.filter((source) => source.enabled).flatMap((source) => {
    if (source.key === "web") return ["readable_source_snapshot:web"];
    if (source.key === "youtube") return ["visible_source_snapshot:youtube"];
    return [];
  });
}

function billingRequiredResearchSourceKeys(plan: ResearchPlanSnapshot): string[] {
  return plan.sources
    .filter((source) => source.enabled && (source.metadata?.apiBillingRequired === true || source.metadata?.billingRequired === true))
    .map((source) => source.key);
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

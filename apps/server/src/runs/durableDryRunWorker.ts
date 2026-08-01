import {
  claimNextDurableJob,
  completeDurableDryRun,
  recoverExpiredDurableJobs,
  type DurableJob
} from "./durableQueue.js";

export type DurableDryRunWorkerResult =
  | { status: "idle"; recoveredJobIds: string[] }
  | { status: "completed"; recoveredJobIds: string[]; job: DurableJob; artifactId: string; proofId: string };

/**
 * Executes only the internal dry-run control-plane path. It never invokes an
 * automation command, browser, connector, network client, or external action.
 */
export function runDurableDryRunWorkerOnce(input: {
  companyId: string;
  serviceUserId: string;
  now?: string;
  leaseMs?: number;
}): DurableDryRunWorkerResult {
  const recovered = recoverExpiredDurableJobs({
    companyId: input.companyId,
    serviceUserId: input.serviceUserId,
    now: input.now
  });
  const claim = claimNextDurableJob({
    companyId: input.companyId,
    serviceUserId: input.serviceUserId,
    kinds: ["dry_run", "scheduled_dry_run"],
    now: input.now,
    leaseMs: input.leaseMs
  });
  if (!claim) return { status: "idle", recoveredJobIds: recovered.map((job) => job.id) };
  const completed = completeDurableDryRun({
    companyId: claim.companyId,
    jobId: claim.id,
    serviceUserId: input.serviceUserId,
    fencingToken: claim.fencingToken,
    now: input.now,
    result: {
      outcome: "durable_control_plane_verified",
      job_id: claim.id,
      run_id: claim.runId,
      automation_id: claim.automationId,
      automation_version_id: claim.automationVersionId,
      payload_hash: claim.payloadHash,
      attempt_no: claim.attemptNo,
      external_action_executed: false
    }
  });
  return {
    status: "completed",
    recoveredJobIds: recovered.map((job) => job.id),
    job: completed.job,
    artifactId: completed.artifactId,
    proofId: completed.proofId
  };
}

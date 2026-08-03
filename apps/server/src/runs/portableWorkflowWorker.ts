import {
  runPortableWorkerCanary,
} from "./portableWorkerCanary.js";
import type { PortableCanaryReceiptV1, PortableTrigger, PortableWorkflowId } from "./portableWorkflowContract.js";

export type PortableWorkerMode =
  | "execute_daily_ai_registered"
  | "execute_nisenprints_registered"
  | "execute_job_submit_registered"
  | "execute_job_followup_registered";

export const PORTABLE_WORKER_CANARY_MODE = "canary" as const;
export const PORTABLE_EXTERNAL_EFFECTS_DISABLED_BLOCKER = "portable_external_effects_disabled" as const;

export function portableWorkflowIdForWorkerAdapter(adapter: string): PortableWorkflowId | null {
  switch (adapter) {
    case "job_submit_registered":
    case "job_followup_registered":
      return "job-application-manager";
    case "daily_ai_registered":
      return "daily-ai-research-publish-run";
    case "nisenprints_registered":
      return "nisenprints-daily-product-canva-printify-etsy-pinterest";
    default:
      return null;
  }
}

export function portableWorkerModeForAdapter(adapter: string): PortableWorkerMode {
  switch (adapter) {
    case "daily_ai_registered":
      return "execute_daily_ai_registered";
    case "nisenprints_registered":
      return "execute_nisenprints_registered";
    case "job_submit_registered":
      return "execute_job_submit_registered";
    case "job_followup_registered":
      return "execute_job_followup_registered";
    default:
      throw new Error("portable_worker_adapter_invalid");
  }
}

export function runPortableWorkflowNoEffect(input: {
  runId: string;
  workflowId: PortableWorkflowId;
  sourceTrigger: PortableTrigger;
  idempotencyKey: string;
}): {
  receipt: PortableCanaryReceiptV1;
  blocker: typeof PORTABLE_EXTERNAL_EFFECTS_DISABLED_BLOCKER;
  external_action_executed: false;
} {
  return {
    receipt: runPortableWorkerCanary(input),
    blocker: PORTABLE_EXTERNAL_EFFECTS_DISABLED_BLOCKER,
    external_action_executed: false
  };
}

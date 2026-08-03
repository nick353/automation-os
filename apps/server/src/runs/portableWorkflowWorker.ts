import {
  runPortableWorkerCanary,
} from "./portableWorkerCanary.js";
import type { PortableCanaryReceiptV1, PortableTrigger, PortableWorkflowId } from "./portableWorkflowContract.js";

export type PortableWorkerMode =
  | "execute_daily_ai_registered"
  | "execute_nisenprints_registered"
  | "execute_job_submit_registered"
  | "execute_job_followup_registered"
  | "execute_prompt_transfer_registered"
  | "execute_sns_multi_poster_registered"
  | "execute_x_authenticated_browser_lane_registered";

export const PORTABLE_WORKER_CANARY_MODE = "canary" as const;
export const PORTABLE_WORKER_EXTERNAL_MODE = "external" as const;
export const PORTABLE_EXTERNAL_EFFECTS_DISABLED_BLOCKER = "portable_external_effects_disabled" as const;

export function portableWorkerExecutionMode(): typeof PORTABLE_WORKER_CANARY_MODE | typeof PORTABLE_WORKER_EXTERNAL_MODE {
  return process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE === PORTABLE_WORKER_EXTERNAL_MODE
    ? PORTABLE_WORKER_EXTERNAL_MODE
    : PORTABLE_WORKER_CANARY_MODE;
}

export function portableWorkflowIdForWorkerAdapter(adapter: string): PortableWorkflowId | null {
  switch (adapter) {
    case "job_submit_registered":
    case "job_followup_registered":
      return "job-application-manager";
    case "daily_ai_registered":
      return "daily-ai-research-publish-run";
    case "nisenprints_registered":
      return "nisenprints-daily-product-canva-printify-etsy-pinterest";
    case "prompt_transfer_registered":
      return "prompt-transfer-ukiyoe";
    case "sns_multi_poster_registered":
      return "sns-multi-poster-ukiyoe";
    case "x_authenticated_browser_lane_registered":
      return "x-authenticated-browser-lane";
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
    case "prompt_transfer_registered":
      return "execute_prompt_transfer_registered";
    case "sns_multi_poster_registered":
      return "execute_sns_multi_poster_registered";
    case "x_authenticated_browser_lane_registered":
      return "execute_x_authenticated_browser_lane_registered";
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

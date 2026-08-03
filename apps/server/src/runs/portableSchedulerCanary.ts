import {
  portableWorkflowManifests,
  type PortableCanaryReceiptV1,
  type PortableWorkflowId
} from "./portableWorkflowContract.js";
import { runPortableWorkerCanary } from "./portableWorkerCanary.js";

export type PortableSchedulerCanaryReceiptV1 = {
  schema: "automation_os_portable_scheduler_canary_v1";
  source_trigger: "automation_os_scheduler";
  scheduled_at: string;
  checked: number;
  completed: number;
  receipts: PortableCanaryReceiptV1[];
  browser_started: false;
  connector_called: false;
  external_action_executed: false;
  exact_blocker: null;
};

export function runPortableSchedulerCanary(now = new Date()): PortableSchedulerCanaryReceiptV1 {
  const scheduledAt = now.toISOString();
  const receipts = (Object.keys(portableWorkflowManifests) as PortableWorkflowId[]).map((workflowId) =>
    runPortableWorkerCanary({
      runId: `portable-scheduler-canary-${workflowId}-${scheduledAt.replace(/[^0-9]/g, "").slice(0, 17)}`,
      workflowId,
      sourceTrigger: "automation_os_scheduler",
      idempotencyKey: `portable-scheduler-canary:${workflowId}:${scheduledAt.slice(0, 10)}`
    })
  );
  return {
    schema: "automation_os_portable_scheduler_canary_v1",
    source_trigger: "automation_os_scheduler",
    scheduled_at: scheduledAt,
    checked: receipts.length,
    completed: receipts.filter((receipt) => receipt.status === "completed").length,
    receipts,
    browser_started: false,
    connector_called: false,
    external_action_executed: false,
    exact_blocker: null
  };
}

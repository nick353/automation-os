import {
  createPortableRunManifestV1,
  portableWorkflowManifests,
  validatePortableWorkflowManifestV1,
  type PortableCanaryReceiptV1,
  type PortableTrigger,
  type PortableWorkflowId
} from "./portableWorkflowContract.js";

export function runPortableWorkerCanary(input: {
  runId: string;
  workflowId: PortableWorkflowId;
  sourceTrigger: PortableTrigger;
  idempotencyKey: string;
}): PortableCanaryReceiptV1 {
  const workflow = validatePortableWorkflowManifestV1(portableWorkflowManifests[input.workflowId]);
  const run = createPortableRunManifestV1(input);
  if (workflow.workflow_id !== run.workflow_id) throw new Error("portable_worker_workflow_binding_mismatch");

  return {
    schema: "automation_os_portable_canary_receipt_v1",
    run_id: run.run_id,
    workflow_id: run.workflow_id,
    status: "completed",
    stages: ["manifest_validation", "run_binding", "readback", "cleanup"],
    browser_started: false,
    connector_called: false,
    external_action_executed: false,
    exact_blocker: null
  };
}

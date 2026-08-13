import {
  createPortableRunManifestV1,
  portableWorkflowManifests,
  validatePortableWorkflowManifestV1,
  type PortableCanaryReceiptV1,
  type PortableTrigger,
  type PortableWorkflowId
} from "./portableWorkflowContract.js";
import {
  createPortableCanaryAdmissionEnvelopeV1,
  portableCanaryAdapterForWorkflow,
  verifyPortableCanaryAdmissionV1
} from "./portableCanaryAdmission.js";
import type { PortableCanaryAdmissionWorkflowId } from "./portableCanaryAdmission.js";
import { hashIdempotencyRequest } from "../automations/idempotency.js";
import {
  createRegisteredRootAdmissionV1,
  validateRegisteredRootAdmissionV1
} from "./registeredRootAdmission.js";

export function runPortableWorkerCanary(input: {
  runId: string;
  workflowId: PortableWorkflowId;
  sourceTrigger: PortableTrigger;
  idempotencyKey: string;
  registeredAutomationId?: string;
}): PortableCanaryReceiptV1 {
  const workflow = validatePortableWorkflowManifestV1(portableWorkflowManifests[input.workflowId]);
  const run = createPortableRunManifestV1(input);
  if (workflow.workflow_id !== run.workflow_id) throw new Error("portable_worker_workflow_binding_mismatch");
  const registeredRoot = createRegisteredRootAdmissionV1({
    registeredAutomationId: input.registeredAutomationId ?? input.workflowId,
    workflowId: input.workflowId,
    runId: input.runId,
    sourceTrigger: input.sourceTrigger,
    definitionFingerprint: hashIdempotencyRequest(workflow)
  });
  validateRegisteredRootAdmissionV1(registeredRoot, {
    registeredAutomationId: registeredRoot.registered_automation_id,
    workflowId: input.workflowId,
    runId: input.runId,
    sourceTrigger: input.sourceTrigger
  });

  const adapter = portableCanaryAdapterForWorkflow(input.workflowId);
  const receipt: PortableCanaryReceiptV1 = {
    schema: "automation_os_portable_canary_receipt_v1",
    run_id: run.run_id,
    workflow_id: run.workflow_id,
    status: "completed",
    stages: ["manifest_validation", "run_binding", "readback", "cleanup"],
    browser_started: false,
    connector_called: false,
    external_action_executed: false,
    exact_blocker: null,
    registered_root_admission: registeredRoot
  };
  if (adapter) {
    const admissionWorkflowId = input.workflowId as PortableCanaryAdmissionWorkflowId;
    for (const operation of receipt.stages) {
      const envelope = createPortableCanaryAdmissionEnvelopeV1({
        runId: run.run_id,
        workflowId: admissionWorkflowId,
        adapter,
        trigger: input.sourceTrigger,
        operation,
        request: input,
        portableReceipt: receipt
      });
      verifyPortableCanaryAdmissionV1({
        envelope,
        runId: run.run_id,
        workflowId: admissionWorkflowId,
        request: input,
        portableReceipt: receipt
      });
    }
  }

  return receipt;
}

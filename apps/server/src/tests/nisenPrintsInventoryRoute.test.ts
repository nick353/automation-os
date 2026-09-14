import assert from "node:assert/strict";
import test from "node:test";
import { localWorkflowManifest, localWorkflowIdForRegisteredAutomation, runPortableLocalWorkflowReadOnly } from "../runs/portableLocalWorkflow.js";
import { portableScheduleDispatchForRegisteredAutomation, portableWorkflowIdForRegisteredAutomation } from "../runs/portableScheduleDispatch.js";
import { planCommandRun } from "../runs/workerEngine.js";

test("explicit inventory variant stays a local audit, with full publication still separate", () => {
  const workflowId = "nisenprints-existing-product-audit";
  const registration = { workerCommandKind: "nisenprints_registered", builderSpec: { canonicalWorkflowId: workflowId } };
  assert.equal(localWorkflowIdForRegisteredAutomation(registration), workflowId);
  const dispatch = portableScheduleDispatchForRegisteredAutomation(registration);
  assert.equal(dispatch?.workflow_id, workflowId);
  assert.equal(dispatch?.browser_surface, "none");
  const plan = planCommandRun(localWorkflowManifest(workflowId).command);
  assert.equal(plan.runContract, undefined);
  assert.ok(plan.tasks.length > 0);
  assert.ok(plan.tasks.every((task) => task.adapter === "nisenprints_inventory_registered"));
  assert.equal(portableScheduleDispatchForRegisteredAutomation({ workerCommandKind: "nisenprints_registered" })?.workflow_id,
    "nisenprints-daily-product-canva-printify-etsy-pinterest");
  const mixedRev7 = {
    workerCommandKind: "nisenprints_inventory_registered",
    builderSpec: {
      canonicalWorkflowId: "nisenprints-daily-product-canva-printify-etsy-pinterest",
      workflowAdapter: {
        adapter: "nisenprints_registered",
        workflow_id: "nisenprints-daily-product-canva-printify-etsy-pinterest"
      }
    }
  };
  assert.equal(portableWorkflowIdForRegisteredAutomation(mixedRev7), null);
  const mixedDispatch = portableScheduleDispatchForRegisteredAutomation(mixedRev7);
  assert.equal(mixedDispatch?.workflow_id, workflowId);
  assert.equal(mixedDispatch?.operation_surface, "mac_local_worker");
  assert.equal(mixedDispatch?.browser_surface, "none");
  const blocked = runPortableLocalWorkflowReadOnly({ workflowId, workerRole: "mac", companyId: "company1" });
  assert.equal(blocked.exact_blocker, "nisen_inventory_run_id_invalid");
});

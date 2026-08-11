import assert from "node:assert/strict";
import test from "node:test";
import {
  registeredBrowserWorkflowCommonBoundaryBlocker,
  REGISTERED_BROWSER_WORKFLOW_COMMON_BOUNDARY_BLOCKER
} from "../runs/registeredBrowserBoundary.js";

test("registered Browser workflow cannot use a direct legacy runner", () => {
  assert.equal(
    registeredBrowserWorkflowCommonBoundaryBlocker({ portableWorkflowId: "daily-ai-research-publish-run", portableRunAdmitted: false }),
    REGISTERED_BROWSER_WORKFLOW_COMMON_BOUNDARY_BLOCKER
  );
  assert.equal(
    registeredBrowserWorkflowCommonBoundaryBlocker({ portableWorkflowId: "x-authenticated-browser-lane", portableRunAdmitted: false }),
    REGISTERED_BROWSER_WORKFLOW_COMMON_BOUNDARY_BLOCKER
  );
});

test("portable canary/external paths are not blocked by the legacy guard", () => {
  assert.equal(
    registeredBrowserWorkflowCommonBoundaryBlocker({ portableWorkflowId: "daily-ai-research-publish-run", portableRunAdmitted: true }),
    null
  );
  assert.equal(
    registeredBrowserWorkflowCommonBoundaryBlocker({ portableWorkflowId: null, portableRunAdmitted: false }),
    null
  );
});

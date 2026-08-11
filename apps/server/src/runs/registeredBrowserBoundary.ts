export const REGISTERED_BROWSER_WORKFLOW_COMMON_BOUNDARY_BLOCKER = "registered_browser_workflow_common_boundary_required" as const;

/**
 * Browser-backed registered workflows have one portable intake/admission /
 * lifecycle owner. A direct legacy runner is not an equivalent fallback: it
 * can otherwise launch a provider before the shared target, lease, readback,
 * and cleanup contract has been admitted.
 */
export function registeredBrowserWorkflowCommonBoundaryBlocker(input: {
  portableWorkflowId: string | null;
  portableRunAdmitted: boolean;
}): typeof REGISTERED_BROWSER_WORKFLOW_COMMON_BOUNDARY_BLOCKER | null {
  if (input.portableWorkflowId && !input.portableRunAdmitted) {
    return REGISTERED_BROWSER_WORKFLOW_COMMON_BOUNDARY_BLOCKER;
  }
  return null;
}

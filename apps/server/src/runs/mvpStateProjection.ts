type JsonObject = Record<string, unknown>;

export type MvpStateProjection = "full" | "ui" | "summary" | "chat";

/**
 * Keep the full MVP state endpoint backward compatible while giving the
 * initial UI a smaller, truthful read-only envelope. These fields are either
 * exact duplicates or are read from their dedicated detail endpoint by the
 * current UI. No source-of-truth rows are dropped from the full projection.
 */
export function projectMvpStateForUi(state: JsonObject): JsonObject {
  const {
    actionableRuns: _actionableRuns,
    approvalInbox: _approvalInbox,
    schedule_occurrences: _scheduleOccurrences,
    steps: _steps,
    lanes: _lanes,
    workerEvents: _workerEvents,
    feedbacks: _feedbacks,
    ...projected
  } = state;
  return {
    ...projected,
    readback_projection: "ui",
    readback_omitted_fields: ["actionableRuns", "approvalInbox", "schedule_occurrences", "steps", "lanes", "workerEvents", "feedbacks"]
  };
}

/**
 * Chat needs an exact company/automation/schedule scope, but it does not need
 * the large run, proof, worker-event, or runtime-process fan-out used by the
 * Runs and company detail screens. Keep this projection explicit so a fast
 * Chat readback cannot be mistaken for the full UI proof surface.
 */
export function projectMvpStateForChat(state: JsonObject): JsonObject {
  return {
    ...state,
    readback_projection: "chat",
    readback_omitted_fields: [
      "full_run_history",
      "approvals",
      "proofs",
      "jobs",
      "memory",
      "feedbacks",
      "browser_runtime_detail"
    ]
  };
}

export function workerChildSpawnFailureSummary(mode: string): Record<string, unknown> {
  return {
    ok: false,
    status: "blocked",
    blocker: "worker_child_spawn_failed",
    reason: "worker_child_spawn_failed",
    mode
  };
}

export const HOOK_WATCHDOG_SCHEMA_V1 = "automation_os_hook_watchdog.v1" as const;
export type HookWatchdogStateV1 = { schema: typeof HOOK_WATCHDOG_SCHEMA_V1; task_id: string; mode: "healthy" | "degraded" | "tripped"; last_heartbeat_at: string | null; timeout_count: number; circuit_open: boolean; exact_blocker: string | null; restart_point: string; read_only_continue: boolean; reversible_continue: boolean; external_effect_fail_closed: boolean };

export function buildHookWatchdog(taskId: string): HookWatchdogStateV1 { return { schema: HOOK_WATCHDOG_SCHEMA_V1, task_id: taskId, mode: "healthy", last_heartbeat_at: null, timeout_count: 0, circuit_open: false, exact_blocker: null, restart_point: "hook_heartbeat", read_only_continue: true, reversible_continue: true, external_effect_fail_closed: true }; }
export function observeHookWatchdog(state: HookWatchdogStateV1, input: { heartbeat: boolean; timedOut?: boolean; taskClass: "read_only" | "reversible_update" | "external_effect" | "release" | "deploy" | "permission_change" }): HookWatchdogStateV1 {
  if (input.heartbeat) return { ...state, mode: "healthy", last_heartbeat_at: new Date().toISOString(), circuit_open: false, exact_blocker: null, restart_point: "hook_heartbeat" };
  const timeoutCount = state.timeout_count + (input.timedOut === false ? 0 : 1);
  const highImpact = !["read_only", "reversible_update"].includes(input.taskClass);
  return { ...state, timeout_count: timeoutCount, mode: highImpact ? "tripped" : "degraded", circuit_open: highImpact, exact_blocker: highImpact ? "hook_watchdog_external_effect_fail_closed" : "hook_watchdog_degraded_observation_only", restart_point: highImpact ? "fresh authority_approval_and_hook_heartbeat" : "continue_task_without_hook_as_business_executor" };
}
